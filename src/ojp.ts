// Shared OJP 2.0 helpers: request envelope, fetch through the /ojp dev proxy, XML parsing, storage.

export type Stop = { ref: string; name: string; lat?: number; lon?: number };
export type Route = { from: Stop; to: Stop };

// Alert texts come back in this language (operator-provided). Must sit in siri:ServiceRequestContext; Params/Language has no effect.
const LANG = "en";

export const envelope = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPRequest><siri:ServiceRequest>
    <siri:ServiceRequestContext><siri:Language>${LANG}</siri:Language></siri:ServiceRequestContext>
    <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
    <siri:RequestorRef>basel-transit</siri:RequestorRef>
    ${inner}
  </siri:ServiceRequest></OJPRequest>
</OJP>`;

export const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

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
const OJP_ENDPOINT = import.meta.env.DEV
  ? "/ojp"
  : "https://api.opentransportdata.swiss/ojp20";

async function post(body: string): Promise<string> {
  const res = await fetch(OJP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      ...(import.meta.env.DEV ? {} : { Authorization: `Bearer ${__OJP_TOKEN__}` }),
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.text();
}

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

export const ojp = async (body: string): Promise<Document> => parseXml(await post(body));

// fetch() rejects with a TypeError when there is no network; HTTP errors are plain Errors.
export const isOffline = (err: unknown) => err instanceof TypeError;

// Online: fetch and remember the raw XML. No network: serve the last stored copy (offlineSince = when it was fetched).
// shortcut: entries are never evicted; a full localStorage just stops caching.
export async function ojpCached(key: string, body: string): Promise<{ doc: Document; offlineSince: Date | null }> {
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
  el.getElementsByTagNameNS("*", tag)[0]?.textContent?.trim() ?? "";
export const all = (el: Element | Document, tag: string) => [...el.getElementsByTagNameNS("*", tag)];

export const parseStops = (doc: Document): Stop[] =>
  all(doc, "PlaceResult")
    .map((p) => ({
      ref: text(p, "StopPlaceRef"),
      name: text(p, "StopPlaceName"),
      lat: Number(text(p, "Latitude")) || undefined,
      lon: Number(text(p, "Longitude")) || undefined,
    }))
    .filter((s) => s.ref);

// Equirectangular approximation: fine at city scale.
export const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const k = 111_320;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.round(Math.hypot(x, (b.lat - a.lat) * k));
};
// Basel SBB <-> Burgfelderplatz is roughly 2 km.
console.assert(
  Math.abs(metres({ lat: 47.54741, lon: 7.58956 }, { lat: 47.56204, lon: 7.57382 }) - 2000) < 100,
  "metres",
);

// Known-stops directory: every stop seen in any response, so search and near me work offline.
type Known = Record<string, { name: string; lat: number; lon: number }>;
const PLACES_KEY = "basel-transit:places";

export function rememberPlaces(stops: Stop[]) {
  const known = loadJson<Known>(PLACES_KEY, {});
  let changed = false;
  for (const s of stops) {
    if (!s.ref || !s.lat || !s.lon) continue;
    const k = known[s.ref];
    if (k && k.name === s.name && k.lat === s.lat && k.lon === s.lon) continue;
    known[s.ref] = { name: s.name, lat: s.lat, lon: s.lon };
    changed = true;
  }
  if (changed) saveJson(PLACES_KEY, known);
}

// Places holds StopPlace, StopPoint and TopographicPlace entries; only StopPlace ones are stops.
export function rememberDoc(doc: Document) {
  rememberPlaces(
    all(doc, "Place")
      .filter((p) => all(p, "StopPlace").length)
      .map((p) => ({
        ref: text(p, "StopPlaceRef"),
        name: text(p, "StopPlaceName"),
        lat: Number(text(p, "Latitude")) || undefined,
        lon: Number(text(p, "Longitude")) || undefined,
      })),
  );
}

const knownList = (): (Stop & { lat: number; lon: number })[] =>
  Object.entries(loadJson<Known>(PLACES_KEY, {})).map(([ref, v]) => ({ ref, ...v }));

export const knownSearch = (q: string): Stop[] => {
  const needle = q.trim().toLowerCase();
  return knownList().filter((s) => s.name.toLowerCase().includes(needle)).slice(0, 10);
};

// 10 nearest known stops within 1 km.
export const knownNear = (here: { lat: number; lon: number }): (Stop & { dist: number })[] =>
  knownList()
    .map((s) => ({ ...s, dist: metres(here, s) }))
    .filter((s) => s.dist <= 1000)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);

// Median gap in minutes between consecutive planned times (given in minutes); null below 3 times.
export const headway = (mins: number[]): number | null => {
  if (mins.length < 3) return null;
  const s = [...mins].sort((a, b) => a - b);
  const gaps = s.slice(1).map((m, i) => m - s[i]).sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
};
console.assert(
  headway([0, 7, 14, 22]) === 7 && headway([0, 30, 60]) === 30 && headway([0, 30]) === null,
  "headway",
);

const dayType = (d: Date) => (d.getDay() === 0 ? "Sun" : d.getDay() === 6 ? "Sat" : "weekday");
const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

// A sampled headway only still applies on the same day type and within 2 hours of the same time of day.
export const headwayApplies = (sampled: Date, now: Date) =>
  dayType(sampled) === dayType(now) && Math.abs(minuteOfDay(sampled) - minuteOfDay(now)) <= 120;
console.assert(
  headwayApplies(new Date(2026, 10, 28, 14, 0), new Date(2026, 10, 28, 15, 30)) &&
    !headwayApplies(new Date(2026, 10, 28, 14, 0), new Date(2026, 10, 28, 17, 0)) &&
    !headwayApplies(new Date(2026, 10, 28, 14, 0), new Date(2026, 10, 29, 14, 0)) &&
    headwayApplies(new Date(2026, 10, 24, 9, 0), new Date(2026, 10, 25, 10, 0)),
  "headwayApplies",
);

export const sampleLabel = (d: Date) => `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${hhmm(d)}`;

// Boarding accessibility for one departure/leg. `at` is the call that carries the platform NameSuffix
// (ThisCall / LegBoard); `el` is the whole StopEvent / TimedLeg, whose Service/Attribute/Code A__NF marks low-floor.
export type Access = "step-free" | "assisted" | "none" | null;
export function access(el: Element, at: Element): Access {
  const platform = text(at, "NameSuffix");
  const lowFloor = all(el, "Code").some((c) => c.textContent?.trim() === "A__NF");
  if (platform === "PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE") return "none";
  if (platform === "PLATFORM_ACCESS_WITHOUT_ASSISTANCE") return lowFloor ? "step-free" : null;
  if (platform === "PLATFORM_ACCESS_WITH_ASSISTANCE") return "assisted";
  return lowFloor ? "assisted" : null;
}
export const replacement = (at: Element) => text(at, "NameSuffix") === "ALTERNATIVE_TRANSPORT";
{
  const t = (suffix: string, nf: boolean) => {
    const d = parseXml(
      `<E xmlns="x"><At><NameSuffix><Text>${suffix}</Text></NameSuffix></At>${nf ? "<Code>A__NF</Code>" : ""}</E>`,
    );
    return access(d.documentElement, all(d, "At")[0]);
  };
  console.assert(
    t("PLATFORM_ACCESS_WITHOUT_ASSISTANCE", true) === "step-free" &&
      t("PLATFORM_ACCESS_WITH_ASSISTANCE", false) === "assisted" &&
      t("", true) === "assisted" &&
      t("PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE", true) === "none" &&
      t("", false) === null,
    "access",
  );
}

// Realtime flags of one departure/leg. `el` holds Service (Cancelled, Deviation); `at` is the ThisCall / LegBoard.
export type Quay = { planned: string; actual: string };
export function flags(el: Element, at: Element) {
  const service = all(el, "Service")[0] ?? el;
  const planned = text(at, "PlannedQuay");
  return {
    cancelled: text(service, "Cancelled") === "true" || text(at, "NotServicedStop") === "true",
    deviation: text(service, "Deviation") === "true",
    quay: { planned, actual: text(at, "EstimatedQuay") || planned } as Quay,
  };
}

// Service alerts. PtSituation sits in the response context; StopEvent/TimedLeg Service/SituationFullRefs point at it.
// The context has one SituationNumber for the situation (suffix "-0") and one related ref without it: match on either.
export type Situation = { id: string[]; summary: string; details: string[]; severity: string; until?: Date };

export const parseSituations = (doc: Document): Situation[] =>
  all(doc, "PtSituation").map((s) => {
    const until = text(s, "EndTime");
    return {
      id: all(s, "SituationNumber").map((n) => n.textContent?.trim() ?? ""),
      summary: text(s, "SummaryText"),
      details: ["ReasonText", "DescriptionText", "ConsequenceText", "RecommendationText", "DurationText"]
        .map((t) => text(s, t))
        .filter(Boolean),
      severity: text(s, "Severity"),
      until: until ? new Date(until) : undefined,
    };
  });

export const situationRefs = (el: Element): string[] =>
  all(el, "SituationFullRef").map((r) => text(r, "SituationNumber")).filter(Boolean);

export type Leg =
  | {
      kind: "ride";
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
  | { kind: "walk"; minutes: number };

export type Trip = { start: Date; end: Date; minutes: number; transfers: number; legs: Leg[]; alerts: string[] };

// "PT1H14M24S" -> 74 (seconds dropped).
export const isoMinutes = (d: string) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
};
console.assert(isoMinutes("PT14M24S") === 14 && isoMinutes("PT1H5M") === 65 && isoMinutes("PT30S") === 0, "isoMinutes");

const time = (el: Element) => {
  const planned = text(el, "TimetabledTime");
  return { planned: new Date(planned), expected: new Date(text(el, "EstimatedTime") || planned) };
};

// shortcut: only TimedLeg and TransferLeg are shown; ContinuousLeg (e.g. walk to an address) is skipped.
function parseLeg(leg: Element): Leg | null {
  const timed = all(leg, "TimedLeg")[0];
  if (timed) {
    const board = all(timed, "LegBoard")[0];
    const alight = all(timed, "LegAlight")[0];
    const dep = time(board);
    return {
      kind: "ride",
      line: text(timed, "PublishedServiceName"),
      mode: text(timed, "PtMode"),
      to: text(timed, "DestinationText"),
      from: text(board, "StopPointName"),
      fromTime: dep.expected,
      ...flags(timed, board),
      alight: text(alight, "StopPointName"),
      alightTime: time(alight).expected,
      delay: Math.round((dep.expected.getTime() - dep.planned.getTime()) / 60000),
      access: access(timed, board),
      replacement: replacement(board),
      stops: all(timed, "LegIntermediate").map((i) => ({ name: text(i, "StopPointName"), time: time(i).expected })),
    };
  }
  const transfer = all(leg, "TransferLeg")[0];
  return transfer ? { kind: "walk", minutes: isoMinutes(text(transfer, "Duration")) } : null;
}

export const parseTrips = (doc: Document): Trip[] =>
  all(doc, "Trip").map((t) => ({
    start: new Date(text(t, "StartTime")),
    end: new Date(text(t, "EndTime")),
    minutes: isoMinutes(text(t, "Duration")),
    transfers: Number(text(t, "Transfers") || 0),
    legs: all(t, "Leg").map(parseLeg).filter((l): l is Leg => l !== null),
    alerts: situationRefs(t),
  }));

if (typeof DOMParser !== "undefined") {
  const d = parseXml(
    `<R xmlns="x"><PtSituation><SituationNumber>a-0</SituationNumber><References><SituationNumber>a</SituationNumber></References>` +
      `<SummaryText>S</SummaryText><ReasonText>R</ReasonText><DurationText>D</DurationText></PtSituation>` +
      `<TimedLeg><Service><Cancelled>true</Cancelled><Deviation>true</Deviation><SituationFullRefs><SituationFullRef><SituationNumber>a-0</SituationNumber></SituationFullRef></SituationFullRefs></Service>` +
      `<LegBoard><PlannedQuay><Text>5</Text></PlannedQuay><EstimatedQuay><Text>10</Text></EstimatedQuay></LegBoard></TimedLeg></R>`,
  );
  const sit = parseSituations(d)[0];
  const tl = all(d, "TimedLeg")[0];
  const f = flags(tl, all(tl, "LegBoard")[0]);
  console.assert(
    sit.id.length === 2 && sit.summary === "S" && sit.details.join() === "R,D" &&
      situationRefs(tl)[0] === "a-0" && f.cancelled && f.deviation && f.quay.planned === "5" && f.quay.actual === "10",
    "situations/flags",
  );
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode etc.): just won't persist.
  }
}

const STOPS_KEY = "basel-transit:stops";
const DEFAULT_STOPS: Stop[] = [{ ref: "ch:1:sloid:89303", name: "Basel, Burgfelderplatz" }];

export const loadStops = (): Stop[] => {
  const s = loadJson<Stop[]>(STOPS_KEY, DEFAULT_STOPS);
  return Array.isArray(s) && s.length ? s : DEFAULT_STOPS;
};
export const saveStops = (stops: Stop[]) => saveJson(STOPS_KEY, stops);

const ROUTES_KEY = "basel-transit:routes";
export const loadRoutes = (): Route[] => {
  const r = loadJson<Route[]>(ROUTES_KEY, []);
  return Array.isArray(r) ? r : [];
};
export const saveRoutes = (routes: Route[]) => saveJson(ROUTES_KEY, routes);

export const hhmm = (d: Date) => d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });

// "Basel, Burgfelderplatz" -> "Burgfelderplatz" for compact headers.
export const short = (name: string) => name.replace(/^Basel,\s*/, "");
