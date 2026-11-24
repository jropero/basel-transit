// Shared OJP 2.0 helpers: request envelope, fetch through the /ojp dev proxy, XML parsing, storage.

export type Stop = { ref: string; name: string; lat?: number; lon?: number };
export type Route = { from: Stop; to: Stop };

export const envelope = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPRequest><siri:ServiceRequest>
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
        <IncludeIntermediateStops>false</IncludeIntermediateStops>
        <UseRealtimeData>explanatory</UseRealtimeData>
      </Params>
    </OJPTripRequest>`);

// Dev uses the Vite proxy (token stays server-side); the static production build
// calls the API directly because the host cannot proxy /ojp.
const OJP_ENDPOINT = import.meta.env.DEV
  ? "/ojp"
  : "https://api.opentransportdata.swiss/ojp20";

export async function ojp(body: string): Promise<Document> {
  const res = await fetch(OJP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      ...(import.meta.env.DEV ? {} : { Authorization: `Bearer ${__OJP_TOKEN__}` }),
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return new DOMParser().parseFromString(await res.text(), "application/xml");
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

export type Leg =
  | {
      kind: "ride";
      line: string;
      mode: string;
      to: string;
      from: string;
      fromTime: Date;
      quay: string;
      alight: string;
      alightTime: Date;
      delay: number;
    }
  | { kind: "walk"; minutes: number };

export type Trip = { start: Date; end: Date; minutes: number; transfers: number; legs: Leg[] };

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
      quay: text(board, "PlannedQuay"),
      alight: text(alight, "StopPointName"),
      alightTime: time(alight).expected,
      delay: Math.round((dep.expected.getTime() - dep.planned.getTime()) / 60000),
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
  }));

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
