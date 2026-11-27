// Shared OJP 2.0 helpers: request envelope, fetch through the /ojp dev proxy, XML parsing, storage.
import { parseWeather, type WeatherNow } from './weather.ts';

export type Stop = { ref: string; name: string; lat?: number; lon?: number };
export type Route = { from: Stop; to: Stop };

// Alert texts come back in this language (operator-provided). Must sit in siri:ServiceRequestContext; Params/Language has no effect.
const LANG = 'en';

export const envelope = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPRequest><siri:ServiceRequest>
    <siri:ServiceRequestContext><siri:Language>${LANG}</siri:Language></siri:ServiceRequestContext>
    <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
    <siri:RequestorRef>basel-transit</siri:RequestorRef>
    ${inner}
  </siri:ServiceRequest></OJPRequest>
</OJP>`;

export const escapeXml = (s: string) => s.replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`);

const locationBody = (initialInput: string) =>
  envelope(`<OJPLocationInformationRequest>
      <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
      <InitialInput>${initialInput}</InitialInput>
      <Restrictions><Type>stop</Type><NumberOfResults>10</NumberOfResults></Restrictions>
    </OJPLocationInformationRequest>`);

export const searchBody = (name: string) => locationBody(`<Name>${escapeXml(name)}</Name>`);

export const nearBody = (lat: number, lon: number, radius = 500) =>
  locationBody(`<GeoRestriction><Circle>
        <Center><siri:Longitude>${lon}</siri:Longitude><siri:Latitude>${lat}</siri:Latitude></Center>
        <Radius>${radius}</Radius>
      </Circle></GeoRestriction>`);

export const tripBody = (from: Stop, to: Stop) =>
  envelope(`<OJPTripRequest>
      <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
      <Origin><PlaceRef><StopPlaceRef>${escapeXml(from.ref)}</StopPlaceRef></PlaceRef></Origin>
      <Destination><PlaceRef><StopPlaceRef>${escapeXml(to.ref)}</StopPlaceRef></PlaceRef></Destination>
      <Params>
        <NumberOfResults>5</NumberOfResults>
        <IncludeIntermediateStops>true</IncludeIntermediateStops>
        <UseRealtimeData>explanatory</UseRealtimeData>
      </Params>
    </OJPTripRequest>`);

// Dev uses the Vite proxy (token stays server-side); the static production build
// calls the API directly because the host cannot proxy /ojp.
const OJP_ENDPOINT = import.meta.env.DEV ? '/ojp' : 'https://api.opentransportdata.swiss/ojp20';

async function post(body: string): Promise<string> {
  const res = await fetch(OJP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      ...(import.meta.env.DEV ? {} : { Authorization: `Bearer ${__OJP_TOKEN__}` }),
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.text();
}

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

export const ojp = async (body: string): Promise<Document> => parseXml(await post(body));

// fetch() rejects with a TypeError when there is no network; HTTP errors are plain Errors.
export const isOffline = (err: unknown) => err instanceof TypeError;

// Online: fetch and remember the raw XML. No network: serve the last stored copy (offlineSince = when it was fetched).
// shortcut: when storage is full, old entries are evicted oldest-first (see saveJson).
export async function ojpCached(
  key: string,
  body: string,
): Promise<{ doc: Document; offlineSince: Date | null }> {
  const k = `basel-transit:cache:${key}`;
  try {
    const xml = await post(body);
    saveJson(k, { at: Date.now(), xml });
    return { doc: parseXml(xml), offlineSince: null };
  } catch (err) {
    const c = loadJson<{ at: number; xml: string } | null>(k, null);
    if (isOffline(err) && c) return { doc: parseXml(c.xml), offlineSince: new Date(c.at) };
    throw err;
  }
}

// Namespace-agnostic lookup: first descendant with this local name, text only.
export const text = (el: Element | Document, tag: string) =>
  el.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() ?? '';
export const all = (el: Element | Document, tag: string) => [
  ...el.getElementsByTagNameNS('*', tag),
];

const placeOf = (p: Element): Stop => ({
  ref: text(p, 'StopPlaceRef'),
  name: text(p, 'StopPlaceName'),
  lat: Number(text(p, 'Latitude')) || undefined,
  lon: Number(text(p, 'Longitude')) || undefined,
});

export const parseStops = (doc: Document): Stop[] =>
  all(doc, 'PlaceResult')
    .map(placeOf)
    .filter(s => s.ref);

// Equirectangular approximation: fine at city scale.
export const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = 111_320;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.round(Math.hypot(x, (b.lat - a.lat) * k));
};
// Basel SBB <-> Burgfelderplatz is roughly 2 km.
console.assert(
  Math.abs(metres({ lat: 47.54741, lon: 7.58956 }, { lat: 47.56204, lon: 7.57382 }) - 2000) <
    100,
  'metres',
);

// Known-stops directory: every stop seen in any response, so search and near me work offline.
type Known = Record<string, { name: string; lat: number; lon: number }>;
const PLACES_KEY = 'basel-transit:places';

const isUnchanged = (k: Known[string] | undefined, s: Stop) =>
  k?.name === s.name && k.lat === s.lat && k.lon === s.lon;

export function rememberPlaces(stops: Stop[]) {
  const known = loadJson<Known>(PLACES_KEY, {});
  let changed = false;
  for (const s of stops) {
    if (!s.ref || !s.lat || !s.lon) continue;
    if (isUnchanged(known[s.ref], s)) continue;
    known[s.ref] = { name: s.name, lat: s.lat, lon: s.lon };
    changed = true;
  }
  if (changed) saveJson(PLACES_KEY, known);
}

// Places holds StopPlace, StopPoint and TopographicPlace entries; only StopPlace ones are stops.
export function rememberDoc(doc: Document) {
  rememberPlaces(
    all(doc, 'Place')
      .filter(p => all(p, 'StopPlace').length)
      .map(p => ({
        ref: text(p, 'StopPlaceRef'),
        name: text(p, 'StopPlaceName'),
        lat: Number(text(p, 'Latitude')) || undefined,
        lon: Number(text(p, 'Longitude')) || undefined,
      })),
  );
}

const knownList = (): (Stop & { lat: number; lon: number })[] =>
  Object.entries(loadJson<Known>(PLACES_KEY, {})).map(([ref, v]) => ({ ref, ...v }));

export const knownSearch = (q: string): Stop[] => {
  const needle = q.trim().toLowerCase();
  return knownList()
    .filter(s => s.name.toLowerCase().includes(needle))
    .slice(0, 10);
};

// Stop search by name. Offline it falls back to the known-stops directory and returns a status;
// other errors propagate.
export async function searchStops(
  query: string,
): Promise<{ stops: Stop[]; status: string | null }> {
  try {
    const found = parseStops(await ojp(searchBody(query)));
    rememberPlaces(found);
    return { stops: found, status: null };
  } catch (err) {
    if (!isOffline(err)) throw err;
    const known = knownSearch(query);
    const status = known.length
      ? `offline · ${known.length} known stops`
      : 'offline · no known stop matches';
    return { stops: known, status };
  }
}

// 10 nearest known stops within 1 km.
export const knownNear = (here: { lat: number; lon: number }): (Stop & { dist: number })[] =>
  knownList()
    .map(s => ({ ...s, dist: metres(here, s) }))
    .filter(s => s.dist <= 1000)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);

export type NearStop = Stop & { dist?: number };

const locate = () =>
  new Promise<{ lat: number; lon: number }>((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error('location not available in this browser'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      err => reject(new Error(`location: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });

// Stops near the device, nearest first: API within 500 m (then 1 km); offline, the known-stops directory.
export async function nearbyStops(): Promise<{ stops: NearStop[]; offline: boolean }> {
  const here = await locate();
  try {
    let found = parseStops(await ojp(nearBody(here.lat, here.lon)));
    if (!found.length) found = parseStops(await ojp(nearBody(here.lat, here.lon, 1000)));
    rememberPlaces(found);
    const stops = found
      .map(s => ({
        ...s,
        dist: s.lat && s.lon ? metres(here, { lat: s.lat, lon: s.lon }) : undefined,
      }))
      .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
    return { stops, offline: false };
  } catch (err) {
    if (!isOffline(err)) throw err;
    return { stops: knownNear(here), offline: true };
  }
}

// Median gap in minutes between consecutive planned times (given in minutes); null below 3 times.
export const headway = (mins: number[]): number | null => {
  if (mins.length < 3) return null;
  const s = [...mins].sort((a, b) => a - b);
  const gaps = s
    .slice(1)
    .map((m, i) => m - s[i])
    .sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
};
console.assert(
  headway([0, 7, 14, 22]) === 7 && headway([0, 30, 60]) === 30 && headway([0, 30]) === null,
  'headway',
);

const dayType = (d: Date) => ({ 0: 'Sun', 6: 'Sat' })[d.getDay() as 0 | 6] ?? 'weekday';
const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

// A sampled headway only still applies on the same day type and within 2 hours of the same time of day.
export const headwayApplies = (sampled: Date, now: Date) =>
  dayType(sampled) === dayType(now) && Math.abs(minuteOfDay(sampled) - minuteOfDay(now)) <= 120;
console.assert(
  headwayApplies(new Date(2026, 10, 28, 14, 0), new Date(2026, 10, 28, 15, 30)) &&
    !headwayApplies(new Date(2026, 10, 28, 14, 0), new Date(2026, 10, 28, 17, 0)) &&
    !headwayApplies(new Date(2026, 10, 28, 14, 0), new Date(2026, 10, 29, 14, 0)) &&
    headwayApplies(new Date(2026, 10, 24, 9, 0), new Date(2026, 10, 25, 10, 0)),
  'headwayApplies',
);

export const sampleLabel = (d: Date) =>
  `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hhmm(d)}`;

// Boarding accessibility for one departure/leg. `at` is the call that carries the platform NameSuffix
// (ThisCall / LegBoard); `el` is the whole StopEvent / TimedLeg, whose Service/Attribute/Code A__NF marks low-floor.
export type Access = 'step-free' | 'assisted' | 'none' | null;
export function access(el: Element, at: Element): Access {
  const platform = text(at, 'NameSuffix');
  const lowFloor = all(el, 'Code').some(c => c.textContent?.trim() === 'A__NF');
  if (platform === 'PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE') return 'none';
  if (platform === 'PLATFORM_ACCESS_WITHOUT_ASSISTANCE') return lowFloor ? 'step-free' : null;
  if (platform === 'PLATFORM_ACCESS_WITH_ASSISTANCE') return 'assisted';
  return lowFloor ? 'assisted' : null;
}
export const replacement = (at: Element) => text(at, 'NameSuffix') === 'ALTERNATIVE_TRANSPORT';
{
  const t = (suffix: string, nf: boolean) => {
    const d = parseXml(
      `<E xmlns="x"><At><NameSuffix><Text>${suffix}</Text></NameSuffix></At>${nf ? '<Code>A__NF</Code>' : ''}</E>`,
    );
    return access(d.documentElement, all(d, 'At')[0]);
  };
  console.assert(
    t('PLATFORM_ACCESS_WITHOUT_ASSISTANCE', true) === 'step-free' &&
      t('PLATFORM_ACCESS_WITH_ASSISTANCE', false) === 'assisted' &&
      t('', true) === 'assisted' &&
      t('PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE', true) === 'none' &&
      t('', false) === null,
    'access',
  );
}

// Realtime flags of one departure/leg. `el` holds Service (Cancelled, Deviation); `at` is the ThisCall / LegBoard.
export type Quay = { planned: string; actual: string };
export function flags(el: Element, at: Element) {
  const service = all(el, 'Service')[0] ?? el;
  const planned = text(at, 'PlannedQuay');
  return {
    cancelled: text(service, 'Cancelled') === 'true' || text(at, 'NotServicedStop') === 'true',
    deviation: text(service, 'Deviation') === 'true',
    quay: { planned, actual: text(at, 'EstimatedQuay') || planned } as Quay,
  };
}

// Service alerts. PtSituation sits in the response context; StopEvent/TimedLeg Service/SituationFullRefs point at it.
// The context has one SituationNumber for the situation (suffix "-0") and one related ref without it: match on either.
export type Situation = {
  id: string[];
  summary: string;
  details: string[];
  severity: string;
  until?: Date;
};

export const parseSituations = (doc: Document): Situation[] =>
  all(doc, 'PtSituation').map(s => {
    const until = text(s, 'EndTime');
    return {
      id: all(s, 'SituationNumber').map(n => n.textContent?.trim() ?? ''),
      summary: text(s, 'SummaryText'),
      details: [
        'ReasonText',
        'DescriptionText',
        'ConsequenceText',
        'RecommendationText',
        'DurationText',
      ]
        .map(t => text(s, t))
        .filter(Boolean),
      severity: text(s, 'Severity'),
      until: until ? new Date(until) : undefined,
    };
  });

export const situationRefs = (el: Element): string[] =>
  all(el, 'SituationFullRef')
    .map(r => text(r, 'SituationNumber'))
    .filter(Boolean);

export type Leg =
  | {
      kind: 'ride';
      line: string;
      mode: string;
      to: string;
      from: string;
      fromTime: Date;
      quay: Quay;
      cancelled: boolean;
      deviation: boolean;
      alight: string;
      alightTime: Date;
      delay: number;
      access: Access;
      replacement: boolean;
      stops: { name: string; time: Date }[];
    }
  | { kind: 'walk'; minutes: number };

export type Trip = {
  start: Date;
  end: Date;
  minutes: number;
  transfers: number;
  legs: Leg[];
  alerts: string[];
};

// "PT1H14M24S" -> 74 (seconds dropped).
export const isoMinutes = (d: string) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
};
console.assert(
  isoMinutes('PT14M24S') === 14 && isoMinutes('PT1H5M') === 65 && isoMinutes('PT30S') === 0,
  'isoMinutes',
);

const time = (el: Element) => {
  const planned = text(el, 'TimetabledTime');
  return {
    planned: new Date(planned),
    expected: new Date(text(el, 'EstimatedTime') || planned),
  };
};

// shortcut: only TimedLeg and TransferLeg are shown; ContinuousLeg (e.g. walk to an address) is skipped.
function parseLeg(leg: Element): Leg | null {
  const timed = all(leg, 'TimedLeg')[0];
  if (timed) {
    const board = all(timed, 'LegBoard')[0];
    const alight = all(timed, 'LegAlight')[0];
    const dep = time(board);
    return {
      kind: 'ride',
      line: text(timed, 'PublishedServiceName'),
      mode: text(timed, 'PtMode'),
      to: text(timed, 'DestinationText'),
      from: text(board, 'StopPointName'),
      fromTime: dep.expected,
      ...flags(timed, board),
      alight: text(alight, 'StopPointName'),
      alightTime: time(alight).expected,
      delay: Math.round((dep.expected.getTime() - dep.planned.getTime()) / 60000),
      access: access(timed, board),
      replacement: replacement(board),
      stops: all(timed, 'LegIntermediate').map(i => ({
        name: text(i, 'StopPointName'),
        time: time(i).expected,
      })),
    };
  }
  const transfer = all(leg, 'TransferLeg')[0];
  return transfer ? { kind: 'walk', minutes: isoMinutes(text(transfer, 'Duration')) } : null;
}

export const parseTrips = (doc: Document): Trip[] =>
  all(doc, 'Trip').map(t => ({
    start: new Date(text(t, 'StartTime')),
    end: new Date(text(t, 'EndTime')),
    minutes: isoMinutes(text(t, 'Duration')),
    transfers: Number(text(t, 'Transfers') || 0),
    legs: all(t, 'Leg')
      .map(parseLeg)
      .filter((l): l is Leg => l !== null),
    alerts: situationRefs(t),
  }));

if (typeof DOMParser !== 'undefined') {
  const d = parseXml(
    `<R xmlns="x"><PtSituation><SituationNumber>a-0</SituationNumber><References><SituationNumber>a</SituationNumber></References>` +
      `<SummaryText>S</SummaryText><ReasonText>R</ReasonText><DurationText>D</DurationText></PtSituation>` +
      `<TimedLeg><Service><Cancelled>true</Cancelled><Deviation>true</Deviation><SituationFullRefs><SituationFullRef><SituationNumber>a-0</SituationNumber></SituationFullRef></SituationFullRefs></Service>` +
      `<LegBoard><PlannedQuay><Text>5</Text></PlannedQuay><EstimatedQuay><Text>10</Text></EstimatedQuay></LegBoard></TimedLeg></R>`,
  );
  const sit = parseSituations(d)[0];
  const tl = all(d, 'TimedLeg')[0];
  const f = flags(tl, all(tl, 'LegBoard')[0]);
  console.assert(
    sit.id.length === 2 &&
      sit.summary === 'S' &&
      sit.details.join() === 'R,D' &&
      situationRefs(tl)[0] === 'a-0' &&
      f.cancelled &&
      f.deviation &&
      f.quay.planned === '5' &&
      f.quay.actual === '10',
    'situations/flags',
  );
}

// Follow a vehicle: OJPTripInfoRequest returns every call of one journey (PreviousCall, OnwardCall in
// `Order`), with ServiceArrival / ServiceDeparture timetabled and estimated times. There is no
// CurrentPosition, so the position is derived from the times (`tripProgress`).
export const tripInfoBody = (journey: string, day: string) =>
  envelope(`<OJPTripInfoRequest>
      <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
      <JourneyRef>${escapeXml(journey)}</JourneyRef>
      <OperatingDayRef>${escapeXml(day)}</OperatingDayRef>
      <Params><IncludeCalls>true</IncludeCalls><IncludeService>true</IncludeService></Params>
    </OJPTripInfoRequest>`);

export type Stamp = { planned: Date; expected: Date; live: boolean };
export type TripCall = {
  ref: string;
  name: string;
  order: number;
  arr: Stamp | null;
  dep: Stamp | null;
};

// Quay-level StopPointRef ("ch:1:sloid:89303:2:4") -> the stop place ("ch:1:sloid:89303").
export const placeRef = (ref: string) => ref.replace(/^(ch:1:sloid:\d+):.*$/, '$1');
console.assert(
  placeRef('ch:1:sloid:89303:2:4') === 'ch:1:sloid:89303' &&
    placeRef('ch:1:sloid:89303') === 'ch:1:sloid:89303' &&
    placeRef('ch:1:sloid:1401858:1:1') === 'ch:1:sloid:1401858',
  'placeRef',
);

function stamp(el: Element | undefined): Stamp | null {
  const planned = el ? text(el, 'TimetabledTime') : '';
  if (!el || !planned) return null;
  const estimated = text(el, 'EstimatedTime');
  return {
    planned: new Date(planned),
    expected: new Date(estimated || planned),
    live: estimated !== '',
  };
}

const CALL_TAGS = new Set(['PreviousCall', 'CurrentCall', 'OnwardCall']);

// All calls of the journey in order; an error answer (HTTP 200 with an ErrorCondition) has none.
export function parseTripInfo(doc: Document): TripCall[] {
  const result = all(doc, 'TripInfoResult')[0];
  if (!result) return [];
  return [...result.children]
    .filter(c => CALL_TAGS.has(c.localName))
    .map(c => ({
      ref: placeRef(text(c, 'StopPointRef')),
      name: text(c, 'StopPointName'),
      order: Number(text(c, 'Order')) || 0,
      arr: stamp(all(c, 'ServiceArrival')[0]),
      dep: stamp(all(c, 'ServiceDeparture')[0]),
    }))
    .sort((a, b) => a.order - b.order);
}

// Where the vehicle is: `index` = the call it is at / arriving at / heading to ("between" = past
// the previous call). Estimated times, else timetabled; the first call has no arrival.
export type Progress = { index: number; state: 'at' | 'arriving' | 'between' };
const ARRIVING_MS = 60_000;
const arriveMs = (c: TripCall) => (c.arr ?? c.dep)?.expected.getTime() ?? NaN;
const leaveMs = (c: TripCall) => (c.dep ?? c.arr)?.expected.getTime() ?? NaN;

function progressAt(
  c: TripCall,
  next: TripCall | undefined,
  index: number,
  now: number,
): Progress | null {
  const arrive = arriveMs(c);
  const leave = leaveMs(c);
  if (index > 0 && now >= arrive - ARRIVING_MS && now < arrive)
    return { index, state: 'arriving' };
  if (now >= arrive && now < leave) return { index, state: 'at' };
  if (next && now >= leave && now < arriveMs(next) - ARRIVING_MS)
    return { index: index + 1, state: 'between' };
  return null;
}

export function tripProgress(calls: TripCall[], now: number): Progress | null {
  for (const [i, c] of calls.entries()) {
    const found = progressAt(c, calls[i + 1], i, now);
    if (found) return found;
  }
  return null;
}

// Time shown for a call: departure, the last call only has an arrival.
export const callStamp = (c: TripCall) => c.dep ?? c.arr;

// Whole minutes a time runs late (never negative).
export const lateMinutes = (s: Stamp | null) =>
  s ? Math.max(0, Math.round((s.expected.getTime() - s.planned.getTime()) / 60000)) : 0;

if (typeof DOMParser !== 'undefined') {
  const t = (h: number, m: number) =>
    `2026-11-27T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
  const st = (tag: string, plan: string, est?: string) =>
    `<${tag}><TimetabledTime>${plan}</TimetabledTime>${est ? `<EstimatedTime>${est}</EstimatedTime>` : ''}</${tag}>`;
  const call = (kind: string, ref: string, order: number, calls: string) =>
    `<${kind}><siri:StopPointRef>${ref}</siri:StopPointRef><StopPointName><Text>S${order}</Text></StopPointName>${calls}<Order>${order}</Order></${kind}>`;
  const doc = parseXml(
    `<R xmlns="x" xmlns:siri="y"><TripInfoResult>` +
      call(
        'OnwardCall',
        'ch:1:sloid:2:1:1',
        2,
        st('ServiceArrival', t(10, 5)) + st('ServiceDeparture', t(10, 6), t(10, 7)),
      ) +
      call('PreviousCall', 'ch:1:sloid:1:1:1', 1, st('ServiceDeparture', t(10, 0), t(10, 1))) +
      call('OnwardCall', 'ch:1:sloid:3:1:1', 3, st('ServiceArrival', t(10, 10), t(10, 11))) +
      `</TripInfoResult></R>`,
  );
  const calls = parseTripInfo(doc);
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 27, h, m, s);
  const prog = (ms: number) => {
    const p = tripProgress(calls, ms);
    return p ? `${p.index}${p.state}` : '-';
  };
  console.assert(
    calls.map(c => c.ref).join() === 'ch:1:sloid:1,ch:1:sloid:2,ch:1:sloid:3' &&
      calls[0].arr === null &&
      calls[0].dep?.live === true &&
      calls[2].dep === null &&
      lateMinutes(callStamp(calls[1])) === 1 &&
      lateMinutes(callStamp(calls[2])) === 1 &&
      parseTripInfo(parseXml('<R xmlns="x"><ErrorCondition/></R>')).length === 0,
    'parseTripInfo',
  );
  // Estimated times: 1 dep 10:01, 2 arr 10:05 dep 10:07, 3 arr 10:11.
  console.assert(
    prog(at(9, 59)) === '-' &&
      prog(at(10, 2)) === '1between' &&
      prog(at(10, 4, 30)) === '1arriving' &&
      prog(at(10, 6)) === '1at' &&
      prog(at(10, 8)) === '2between' &&
      prog(at(10, 10, 30)) === '2arriving' &&
      prog(at(10, 11, 30)) === '-',
    'tripProgress',
  );
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

const DISPOSABLE = ['basel-transit:cache:', 'basel-transit:onward'];

/** Cache-like keys (JSON `{ at }`), oldest first; missing or unparseable `at` counts as 0. */
function disposableKeysOldestFirst(): string[] {
  try {
    const keys: { key: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !DISPOSABLE.some(p => key.startsWith(p))) continue;
      keys.push({ key, at: Number(loadJson<{ at?: number }>(key, {}).at) || 0 });
    }
    return keys.sort((a, b) => a.at - b.at).map(k => k.key);
  } catch {
    return [];
  }
}

export function saveJson(key: string, value: unknown) {
  const json = JSON.stringify(value);
  try {
    localStorage.setItem(key, json);
    return;
  } catch {
    // Full or unavailable: evict disposable entries below.
  }
  for (const old of disposableKeysOldestFirst()) {
    if (old === key) continue;
    try {
      localStorage.removeItem(old);
      localStorage.setItem(key, json);
      return;
    } catch {
      // Still full (or unavailable): try the next one.
    }
  }
}

const STOPS_KEY = 'basel-transit:stops';
const DEFAULT_STOPS: Stop[] = [{ ref: 'ch:1:sloid:89303', name: 'Basel, Burgfelderplatz' }];

export const loadStops = (): Stop[] => {
  const s = loadJson<Stop[]>(STOPS_KEY, DEFAULT_STOPS);
  return Array.isArray(s) && s.length ? s : DEFAULT_STOPS;
};
export const saveStops = (stops: Stop[]) => saveJson(STOPS_KEY, stops);

// Swaps a saved stop with its neighbour; an out-of-range move returns the same array.
export const moveSaved = (stops: Stop[], index: number, delta: -1 | 1): Stop[] => {
  const to = index + delta;
  if (index < 0 || index >= stops.length || to < 0 || to >= stops.length) return stops;
  const next = [...stops];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
};
{
  const abc = ['a', 'b', 'c'].map(ref => ({ ref, name: ref.toUpperCase() }));
  const refs = (x: Stop[]) => x.map(v => v.ref).join('');
  console.assert(refs(moveSaved(abc, 1, -1)) === 'bac', 'moveSaved up');
  console.assert(refs(moveSaved(abc, 1, 1)) === 'acb', 'moveSaved down');
  console.assert(moveSaved(abc, 0, -1) === abc, 'moveSaved first up');
  console.assert(moveSaved(abc, 2, 1) === abc, 'moveSaved last down');
  console.assert(refs(abc) === 'abc', 'moveSaved does not mutate');
}

const ROUTES_KEY = 'basel-transit:routes';
export const loadRoutes = (): Route[] => {
  const r = loadJson<Route[]>(ROUTES_KEY, []);
  return Array.isArray(r) ? r : [];
};
export const saveRoutes = (routes: Route[]) => saveJson(ROUTES_KEY, routes);

export const hhmm = (d: Date) =>
  d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

// "Basel, Burgfelderplatz" -> "Burgfelderplatz" for compact headers.
export const short = (name: string) => name.replace(/^Basel,\s*/, '');

// "Riehen, Dorfplatz" -> town "Riehen", stop "Dorfplatz": split on the first ", ". Railway
// stations have no comma and start with their town ("Basel SBB", "Muttenz"): the first word is
// the town and the stop keeps the whole name.
export const splitTown = (name: string): { town: string; stop: string } => {
  const i = name.indexOf(', ');
  if (i >= 0) return { town: name.slice(0, i), stop: name.slice(i + 2) };
  return { town: name.trim().split(/\s+/)[0] ?? '', stop: name };
};

// Per row of a stop list: the town to announce above it (the first town, then wherever it changes),
// else ''. A name without a town announces nothing and does not end the current one.
export function townHeadings(names: string[]): string[] {
  let last = '';
  return names.map(n => {
    const { town } = splitTown(n);
    const entering = town && town !== last ? town : '';
    last = town || last;
    return entering;
  });
}
console.assert(
  splitTown('Basel, Burgfelderplatz').town === 'Basel' &&
    splitTown('Basel, Burgfelderplatz').stop === 'Burgfelderplatz' &&
    splitTown('Saint-Louis (F), Gare, Nord').stop === 'Gare, Nord' &&
    splitTown('Basel SBB').town === 'Basel' &&
    splitTown('Basel SBB').stop === 'Basel SBB' &&
    splitTown('Muttenz').town === 'Muttenz' &&
    splitTown('').town === '' &&
    townHeadings([
      'Basel, A',
      'Basel, B',
      'Basel SBB',
      'Riehen, C',
      'Riehen, D',
      'Basel, E',
    ]).join('|') === 'Basel|||Riehen||Basel',
  'splitTown / townHeadings',
);

// Coordinates of a stop from the known-stops directory (filled by every response), or none.
export const knownCoords = (ref: string): { lat: number; lon: number } | null => {
  const k = loadJson<Known>(PLACES_KEY, {})[ref];
  return k ? { lat: k.lat, lon: k.lon } : null;
};

// "ch:1:sloid:89303" -> "89303" (the number shown as the stop code); '' for another ref format.
export const sloidNumber = (ref: string) => /sloid:(\d+)/.exec(ref)?.[1] ?? '';
console.assert(
  sloidNumber('ch:1:sloid:89303') === '89303' && sloidNumber('x') === '',
  'sloidNumber',
);

// Stops around one stop from a LocationInformationRequest: each with its distance and the
// modes it serves (PtMode of the Place), nearest first, without the stop itself.
export type NearbyStop = Stop & { dist: number; modes: string[] };
export function parseNearby(doc: Document, here: Stop & { lat: number; lon: number }) {
  const out: NearbyStop[] = [];
  for (const p of all(doc, 'PlaceResult')) {
    const s = placeOf(p);
    if (!s.ref || !s.lat || !s.lon || s.ref === here.ref) continue;
    const modes = [...new Set(all(p, 'PtMode').map(m => m.textContent?.trim() ?? ''))];
    out.push({
      ...s,
      dist: metres(here, { lat: s.lat, lon: s.lon }),
      modes: modes.filter(Boolean),
    });
  }
  return out.sort((a, b) => a.dist - b.dist);
}
if (typeof DOMParser !== 'undefined') {
  const place = (ref: string, lon: number, mode: string) =>
    `<PlaceResult><Place><StopPlace><StopPlaceRef>${ref}</StopPlaceRef><StopPlaceName><Text>Basel, ${ref}</Text></StopPlaceName></StopPlace>` +
    `<GeoPosition><Longitude>${lon}</Longitude><Latitude>47.5</Latitude></GeoPosition><Mode><PtMode>${mode}</PtMode></Mode><Mode><PtMode>${mode}</PtMode></Mode></Place></PlaceResult>`;
  const doc = parseXml(
    `<R xmlns="x">${place('far', 7.51, 'bus')}${place('me', 7.5, 'tram')}${place('near', 7.5005, 'tram')}</R>`,
  );
  const out = parseNearby(doc, { ref: 'me', name: 'me', lat: 47.5, lon: 7.5 });
  console.assert(
    out.length === 2 &&
      out[0].ref === 'near' &&
      out[0].modes.join() === 'tram' &&
      out[0].dist > 30 &&
      out[0].dist < 40,
    'parseNearby',
  );
}

const NEARBY_RADIUS = 300;
const NEARBY_MAX = 6;
const nearbyMemo = new Map<string, Promise<NearbyStop[]>>();

// Other stops within ~300 m (max 6), memoised per stop for the session; a failure is not memoised.
export function fetchNearby(here: Stop & { lat: number; lon: number }): Promise<NearbyStop[]> {
  const memo = nearbyMemo.get(here.ref);
  if (memo) return memo;
  const p = ojp(nearBody(here.lat, here.lon, NEARBY_RADIUS)).then(doc => {
    rememberPlaces(parseStops(doc));
    return parseNearby(doc, here)
      .filter(s => s.dist <= NEARBY_RADIUS)
      .slice(0, NEARBY_MAX);
  });
  nearbyMemo.set(here.ref, p);
  p.catch(() => nearbyMemo.delete(here.ref));
  return p;
}

// Current weather (Open-Meteo, no key) per coordinate rounded to 2 decimals (~1 km), so nearby
// stops share one request and the exact stop is not sent. Memoised 15 min; the last answer per
// coordinate is kept for offline (evictable `cache:` entry, one small entry per rounded
// coordinate, dropped past 3 h). Never throws.
const WEATHER_MEMO_MS = 15 * 60_000;
const WEATHER_STORED_MAX_MS = 3 * 60 * 60_000;
const WEATHER_TIMEOUT_MS = 8000;
const weatherMemo = new Map<string, { at: number; p: Promise<WeatherNow | null> }>();
export const weatherKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
const weatherStore = (key: string) => `basel-transit:cache:weather:${key}`;

export function storedWeather(key: string): WeatherNow | null {
  const saved = loadJson<{ at?: number; w?: WeatherNow } | null>(weatherStore(key), null);
  const fresh = saved?.w && Date.now() - (saved.at ?? 0) < WEATHER_STORED_MAX_MS;
  return fresh ? (saved.w ?? null) : null;
}

async function loadWeather(key: string): Promise<WeatherNow | null> {
  const [lat, lon] = key.split(',');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        '&current=temperature_2m,weather_code,is_day&timezone=Europe%2FZurich',
      { signal: ctl.signal },
    );
    const w = res.ok ? parseWeather(await res.json()) : null;
    if (w) saveJson(weatherStore(key), { at: Date.now(), w });
    return w ?? storedWeather(key);
  } catch {
    return storedWeather(key);
  } finally {
    clearTimeout(timer);
  }
}

export function fetchWeather(key: string): Promise<WeatherNow | null> {
  const hit = weatherMemo.get(key);
  if (hit && Date.now() - hit.at < WEATHER_MEMO_MS) return hit.p;
  const p = loadWeather(key);
  weatherMemo.set(key, { at: Date.now(), p });
  // A failed fetch is not memoised: the next stop change or page show retries.
  void p.then(w => w || weatherMemo.delete(key));
  return p;
}
