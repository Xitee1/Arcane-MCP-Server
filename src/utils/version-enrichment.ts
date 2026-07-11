/**
 * Enrich digest-only update checks with human-readable versions.
 *
 * Arcane's checker only compares digests. This helper translates them:
 * the locally running version comes from container labels (containers
 * inherit the image's OCI labels), the upstream version from the registry
 * manifest's version label. Everything is best-effort — on any failure the
 * digests are shown as before.
 */

import type { ArcaneClient } from "../client/arcane-client.js";
import type { ImageUpdateResponse } from "../types/arcane-types.js";
import { parseImageRef, resolveRemoteVersion, listNewestVersionTags } from "./registry-client.js";

const VERSION_LABELS = ["org.opencontainers.image.version", "org.label-schema.version"];

/** Version of the locally running image, read from a matching container's labels. */
export async function lookupLocalVersion(
  client: ArcaneClient,
  environmentId: string,
  imageRef: string
): Promise<string | undefined> {
  try {
    const containers = await client.get<{
      data: Array<{ image: string; labels?: Record<string, string> | null }>;
    }>(`/environments/${environmentId}/containers`, { limit: 200 });

    const match = (containers.data || []).find(
      (c) => c.image === imageRef || c.image.startsWith(`${imageRef}@`)
    );
    if (!match?.labels) return undefined;
    return VERSION_LABELS.map((l) => match.labels![l]).find(Boolean);
  } catch {
    return undefined;
  }
}

export interface VersionInfo {
  local?: string;
  remote?: string;
  newestTags?: string[];
}

/** Best-effort version resolution (local label, upstream label, newest stable tags). */
export async function resolveVersions(
  client: ArcaneClient,
  environmentId: string,
  imageRef: string,
  options?: { includeTags?: boolean }
): Promise<VersionInfo> {
  const parsed = parseImageRef(imageRef);

  const [local, remote, tags] = await Promise.allSettled([
    lookupLocalVersion(client, environmentId, imageRef),
    resolveRemoteVersion(parsed),
    options?.includeTags ? listNewestVersionTags(parsed, 6) : Promise.resolve(undefined),
  ]);

  return {
    local: local.status === "fulfilled" ? local.value : undefined,
    remote: remote.status === "fulfilled" ? remote.value.version : undefined,
    newestTags: tags.status === "fulfilled" ? tags.value : undefined,
  };
}

/** Full output for the single-image update check tools. */
export async function formatEnrichedUpdateCheck(
  client: ArcaneClient,
  environmentId: string,
  imageRef: string,
  u: ImageUpdateResponse
): Promise<string> {
  if (u.error) {
    return `Check failed for ${imageRef}: ${u.error}`;
  }
  if (!u.hasUpdate) {
    return `${imageRef} is up to date.`;
  }

  const versions = await resolveVersions(client, environmentId, imageRef, { includeTags: true });

  const current =
    versions.local || u.currentVersion || u.currentDigest?.substring(0, 19) || "unknown";
  const latest =
    versions.remote || u.latestVersion || u.latestDigest?.substring(0, 19) || "unknown";

  const lines = [
    `Update available for ${imageRef}! (${u.updateType || "update"})`,
    `  Running: ${current}`,
    `  Upstream '${parseImageRef(imageRef).tag}' tag: ${latest}`,
  ];

  if (!versions.local && !versions.remote) {
    lines.push("  (No version labels found — digests shown. Arcane itself only compares digests.)");
  }
  if (versions.newestTags?.length) {
    lines.push(`  Newest version tags in registry: ${versions.newestTags.join(", ")}`);
  }

  return lines.join("\n");
}
