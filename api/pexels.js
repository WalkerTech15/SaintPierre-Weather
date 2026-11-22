const PEXELS_SEARCH_ENDPOINT = "https://api.pexels.com/v1/search";
const PEXELS_PHOTOS_ENDPOINT = "https://api.pexels.com/v1/photos";
const UPSTREAM_TIMEOUT_MS = 8000;
// Reject C0/C1 controls before trimming so tabs/newlines cannot be normalized away.
// eslint-disable-next-line no-control-regex -- rejecting these characters is intentional
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]");

/* Pexels photo IDs are positive integers. Bounding the digit count keeps an
   absurdly long string from ever reaching the upstream URL. */
const ID_PATTERN = /^[1-9][0-9]{0,15}$/;
/* "Request multiple candidates instead of accepting only the first result" —
   the client ranks these against the location's name/region/country/photo
   metadata (see rankPexelsCandidates in photo-api.js) rather than trusting
   Pexels' own relevance order alone. */
const CANDIDATE_COUNT = 8;

function safeProviderUrl(value, hostname, maxLength = 2048) {
  if (typeof value !== "string" || value.length > maxLength) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== hostname || url.username || url.password) {
      return "";
    }
    return value;
  } catch {
    return "";
  }
}

export function toPhotoPayload(photo) {
  if (!photo || typeof photo !== "object") return null;
  const src = photo?.src || {};
  const large = safeProviderUrl(src.large, "images.pexels.com");
  if (!large) return null;

  const medium = safeProviderUrl(src.medium, "images.pexels.com");
  const large2x = safeProviderUrl(src.large2x, "images.pexels.com");
  const pexelsLink = safeProviderUrl(photo.url, "www.pexels.com");
  return {
    src: {
      ...(medium ? { medium } : {}),
      large,
      ...(large2x ? { large2x } : {}),
    },
    photographer: typeof photo.photographer === "string" ? photo.photographer.slice(0, 120) : "",
    link: pexelsLink,
    alt: typeof photo.alt === "string" ? photo.alt.slice(0, 200) : "",
  };
}

function send(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", status === 200 ? "public, max-age=600" : "no-store");
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "method_not_allowed" });
  }

  /* Curated locations (src/js/data/locations.js) carry a manually reviewed
     Pexels photo ID so the hero/card image is guaranteed to show the actual
     landmark rather than whatever a text search ranks first. This branch
     fetches that exact photo; the search branch below is unchanged and still
     serves every other (non-curated) location. */
  const idParam = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (idParam) {
    if (!ID_PATTERN.test(idParam)) {
      return send(res, 400, { error: "invalid_id" });
    }

    const key = process.env.PEXELS_API_KEY;
    if (!key) {
      return send(res, 503, { error: "unavailable" });
    }

    try {
      const response = await fetch(`${PEXELS_PHOTOS_ENDPOINT}/${idParam}`, {
        headers: {
          Authorization: key,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (response.status === 404) {
        return send(res, 404, { error: "not_found" });
      }
      if (response.status === 429) {
        return send(res, 429, { error: "rate_limited" });
      }
      if (!response.ok) {
        return send(res, 502, { error: "upstream_error" });
      }

      const photo = await response.json();
      return send(res, 200, { photo: toPhotoPayload(photo) });
    } catch {
      return send(res, 502, { error: "upstream_error" });
    }
  }

  const rawQuery = typeof req.query.query === "string" ? req.query.query : "";
  if (CONTROL_CHARS.test(rawQuery)) return send(res, 400, { error: "invalid_query" });
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > 120) {
    return send(res, 400, { error: "invalid_query" });
  }

  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    return send(res, 503, { error: "unavailable" });
  }

  try {
    const response = await fetch(
      `${PEXELS_SEARCH_ENDPOINT}?${new URLSearchParams({
        query,
        orientation: "landscape",
        per_page: String(CANDIDATE_COUNT),
        size: "medium",
      })}`,
      {
        headers: {
          Authorization: key,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );

    if (response.status === 429) {
      return send(res, 429, { error: "rate_limited" });
    }

    if (!response.ok) {
      return send(res, 502, { error: "upstream_error" });
    }

    const data = await response.json();
    const photos = (data.photos || []).map(toPhotoPayload).filter(Boolean);

    /* `photo` (first candidate) kept for anything relying on the old
       single-photo shape; `photos` is the new ranked-candidate pool the
       client picks the best match from (see rankPexelsCandidates in
       photo-api.js). */
    return send(res, 200, { photo: photos[0] || null, photos });
  } catch {
    return send(res, 502, { error: "upstream_error" });
  }
}
