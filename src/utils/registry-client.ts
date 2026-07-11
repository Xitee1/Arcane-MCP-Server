/**
 * Minimal OCI registry client (read-only, anonymous auth).
 *
 * Arcane's update checker only compares digests and never resolves version
 * numbers. This client fills that gap by querying the registry directly:
 * the version label of the image behind a tag, and the newest version tags.
 * Works with any registry implementing the OCI distribution spec + token
 * auth (docker.io, ghcr.io, lscr.io, quay.io, …) for public images.
 */

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const VERSION_LABELS = ["org.opencontainers.image.version", "org.label-schema.version", "version"];

const REGISTRY_TIMEOUT_MS = 10000;
const MAX_TAG_PAGES = 10;
const TAG_PAGE_SIZE = 500;

/** token cache: registry|repo → {token, expiresAt} */
const tokenCache = new Map<string, { token: string | null; expiresAt: number }>();

export interface ParsedImageRef {
  registry: string;
  repository: string;
  tag: string;
  display: string;
}

/** Split an image reference into registry host, repository, and tag (Docker normalization rules). */
export function parseImageRef(ref: string): ParsedImageRef {
  let rest = ref.trim();
  // strip a pinned digest suffix
  rest = rest.split("@")[0];

  let registry = "registry-1.docker.io";
  const firstSegment = rest.split("/")[0];
  if (rest.includes("/") && (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost")) {
    registry = firstSegment === "docker.io" ? "registry-1.docker.io" : firstSegment;
    rest = rest.substring(firstSegment.length + 1);
  }

  let tag = "latest";
  const tagIdx = rest.lastIndexOf(":");
  if (tagIdx > -1 && !rest.substring(tagIdx).includes("/")) {
    tag = rest.substring(tagIdx + 1);
    rest = rest.substring(0, tagIdx);
  }

  // Docker Hub official images live under library/
  if (registry === "registry-1.docker.io" && !rest.includes("/")) {
    rest = `library/${rest}`;
  }

  return { registry, repository: rest, tag, display: ref };
}

async function registryFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Anonymous bearer token via the WWW-Authenticate challenge (null = registry needs no auth). */
async function getToken(registry: string, repository: string): Promise<string | null> {
  const key = `${registry}|${repository}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const probe = await registryFetch(`https://${registry}/v2/`, {});
  let token: string | null = null;

  if (probe.status === 401) {
    const challenge = probe.headers.get("www-authenticate") || "";
    const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!fields.realm) {
      throw new Error(`Registry ${registry} requires authentication (no anonymous token endpoint).`);
    }
    const tokenUrl = `${fields.realm}?service=${encodeURIComponent(fields.service || "")}&scope=${encodeURIComponent(`repository:${repository}:pull`)}`;
    const response = await registryFetch(tokenUrl, {});
    if (!response.ok) {
      throw new Error(`Anonymous access to ${registry}/${repository} denied (private image?).`);
    }
    const body = (await response.json()) as { token?: string; access_token?: string };
    token = body.token || body.access_token || null;
  }

  tokenCache.set(key, { token, expiresAt: Date.now() + 4 * 60 * 1000 });
  return token;
}

function authHeaders(token: string | null, extra?: Record<string, string>): Record<string, string> {
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra || {}) };
}

/** Resolve the version label + digest of the image currently behind a tag. */
export async function resolveRemoteVersion(parsed: ParsedImageRef): Promise<{ version?: string; digest?: string }> {
  const token = await getToken(parsed.registry, parsed.repository);
  const base = `https://${parsed.registry}/v2/${parsed.repository}`;

  const manifestResponse = await registryFetch(`${base}/manifests/${parsed.tag}`, authHeaders(token, { Accept: MANIFEST_ACCEPT }));
  if (!manifestResponse.ok) {
    throw new Error(`Registry lookup failed for ${parsed.display}: HTTP ${manifestResponse.status}`);
  }
  const digest = manifestResponse.headers.get("docker-content-digest") || undefined;
  let manifest = (await manifestResponse.json()) as {
    manifests?: Array<{ digest: string; platform?: { architecture?: string; os?: string } }>;
    config?: { digest: string };
  };

  // Multi-arch index: descend into the linux/amd64 entry (or the first one)
  if (manifest.manifests?.length) {
    const entry =
      manifest.manifests.find((m) => m.platform?.architecture === "amd64" && m.platform?.os === "linux") ||
      manifest.manifests.find((m) => m.platform?.os !== "unknown") ||
      manifest.manifests[0];
    const inner = await registryFetch(`${base}/manifests/${entry.digest}`, authHeaders(token, { Accept: MANIFEST_ACCEPT }));
    if (!inner.ok) throw new Error(`Registry manifest fetch failed: HTTP ${inner.status}`);
    manifest = (await inner.json()) as { config?: { digest: string } };
  }

  if (!manifest.config?.digest) return { digest };

  const blob = await registryFetch(`${base}/blobs/${manifest.config.digest}`, authHeaders(token));
  if (!blob.ok) return { digest };
  const config = (await blob.json()) as { config?: { Labels?: Record<string, string> } };
  const labels = config.config?.Labels || {};
  const version = VERSION_LABELS.map((l) => labels[l]).find(Boolean);

  return { version, digest };
}

const SEMVER_TAG = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([.-].*)?$/;
const PRERELEASE_SUFFIX = /(rc|beta|alpha|dev|develop|nightly|unstable|test|preview)/i;

function semverKey(tag: string): number[] | null {
  const m = tag.match(SEMVER_TAG);
  if (!m) return null;
  // Skip pre-release/dev tags — users want stable versions
  if (m[4] && PRERELEASE_SUFFIX.test(m[4])) return null;
  return [Number(m[1]), Number(m[2] ?? -1), Number(m[3] ?? -1)];
}

/** Newest version-looking tags of a repository, newest first. */
export async function listNewestVersionTags(parsed: ParsedImageRef, limit: number): Promise<string[]> {
  const token = await getToken(parsed.registry, parsed.repository);
  const base = `https://${parsed.registry}`;

  let url: string | null = `${base}/v2/${parsed.repository}/tags/list?n=${TAG_PAGE_SIZE}`;
  const tags: string[] = [];

  for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
    const response = await registryFetch(url, authHeaders(token));
    if (!response.ok) {
      throw new Error(`Tag listing failed for ${parsed.display}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { tags?: string[] | null };
    tags.push(...(body.tags || []));

    const link = response.headers.get("link");
    const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next ? new URL(next, base).toString() : null;
  }

  return tags
    .map((tag) => ({ tag, key: semverKey(tag) }))
    .filter((t): t is { tag: string; key: number[] } => t.key !== null)
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2] || b.tag.localeCompare(a.tag))
    .slice(0, limit)
    .map((t) => t.tag);
}
