// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import { rm, rmSync } from "node:fs";

import type { AssetResource } from "@t3tools/contracts";
import {
  AssetAttachmentNotFoundError,
  AssetPreviewTypeValidationError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetSigningKeyLoadError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspacePathValidationError,
  AssetWorkspaceResolutionError,
  AssetWorkspaceRootNormalizationError,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";

const SIGNING_SECRET_NAME = "asset-access-signing-key";
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const PI_EXPORT_ARTIFACT_LIMIT = 32;

interface ExportArtifact {
  readonly canonicalPath: string;
  readonly directory: string;
  readonly fileName: string;
  readonly expiresAt: number;
}

const exportArtifacts = new Map<string, ExportArtifact>();
const pendingExportCleanup = new Set<string>();
const exportArtifactLock = Semaphore.makeUnsafe(1);

function removeExportArtifact(handle: string, artifact: ExportArtifact): void {
  if (exportArtifacts.get(handle) !== artifact) return;
  rm(artifact.directory, { recursive: true, force: true }, (error) => {
    if (error === null && exportArtifacts.get(handle) === artifact) {
      exportArtifacts.delete(handle);
    }
  });
}

function retryPendingExportCleanup(directory: string): void {
  rm(directory, { recursive: true, force: true }, (error) => {
    if (error === null) pendingExportCleanup.delete(directory);
  });
}

const exportCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [handle, artifact] of exportArtifacts) {
    if (artifact.expiresAt <= now) removeExportArtifact(handle, artifact);
  }
  for (const directory of pendingExportCleanup) retryPendingExportCleanup(directory);
}, 60_000);
exportCleanupTimer.unref();

process.once("exit", () => {
  for (const artifact of exportArtifacts.values()) {
    rmSync(artifact.directory, { recursive: true, force: true });
  }
  for (const directory of pendingExportCleanup) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

const AssetClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file"),
    workspaceRoot: Schema.String,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file-exact"),
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("pi-html-export"),
    handle: Schema.String,
    expiresAt: Schema.Number,
  }),
]);
type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset = {
  readonly kind: "file";
  readonly path: string;
  readonly downloadName?: string;
};

function decodeClaims(encodedPayload: string): AssetClaims | null {
  try {
    return Option.getOrNull(decodeAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeed(Option.none()),
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value));
    return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
  },
);

const resolveCanonicalWorkspaceFileForRequest = (input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}) =>
  resolveCanonicalWorkspaceFile(input).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to resolve canonical asset path.", {
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
  let claims: AssetClaims;
  let fileName: string;

  switch (input.resource._tag) {
    case "workspace-file": {
      if (!input.workspaceRoot) {
        return yield* new AssetWorkspaceContextNotFoundError({
          resource: input.resource,
        });
      }
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = path.isAbsolute(input.resource.path)
        ? path.relative(workspaceRoot, input.resource.path)
        : input.resource.path;
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspacePathValidationError({
                resource: input.resource,
                cause,
              }),
          ),
        );
      if (!isWorkspacePreviewEntryPath(resolved.relativePath)) {
        return yield* new AssetPreviewTypeValidationError({
          resource: input.resource,
        });
      }
      const canonicalFile = yield* resolveCanonicalWorkspaceFile({
        workspaceRoot,
        relativePath: resolved.relativePath,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceAssetInspectionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (!canonicalFile) {
        return yield* new AssetWorkspaceAssetNotFoundError({
          resource: input.resource,
        });
      }
      const canonicalWorkspaceRoot = yield* fileSystem.realPath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      claims = isWorkspaceImagePreviewPath(resolved.relativePath)
        ? {
            version: 1,
            kind: "workspace-file-exact",
            workspaceRoot: canonicalWorkspaceRoot,
            relativePath: resolved.relativePath,
            expiresAt,
          }
        : {
            version: 1,
            kind: "workspace-file",
            workspaceRoot: canonicalWorkspaceRoot,
            baseRelativePath: path.dirname(resolved.relativePath),
            expiresAt,
          };
      fileName = path.basename(resolved.relativePath);
      break;
    }
    case "attachment": {
      const config = yield* ServerConfig.ServerConfig;
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.resource.attachmentId,
      });
      if (!attachmentPath) {
        return yield* new AssetAttachmentNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        expiresAt,
      };
      fileName = path.basename(attachmentPath);
      break;
    }
    case "project-favicon": {
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.resource.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
      const faviconPath = yield* faviconResolver.resolvePath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetProjectFaviconResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = faviconPath ? path.relative(workspaceRoot, faviconPath) : null;
      if (
        relativePath &&
        !(yield* resolveCanonicalWorkspaceFile({ workspaceRoot, relativePath }).pipe(
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        ))
      ) {
        return yield* new AssetProjectFaviconNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "project-favicon",
        workspaceRoot: yield* fileSystem.realPath(workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceResolutionError({
                resource: input.resource,
                cause,
              }),
          ),
        ),
        relativePath,
        expiresAt,
      };
      fileName = relativePath ? path.basename(relativePath) : PROJECT_FAVICON_FALLBACK_MARKER;
      break;
    }
  }

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.mapError(
      (cause) =>
        new AssetSigningKeyLoadError({
          resource: input.resource,
          cause,
        }),
    ),
  );
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
  };
});

export const issuePiExportAssetUrl = (input: {
  readonly canonicalPath: string;
  readonly fileName: string;
}) => {
  let unregisteredDirectory: string | undefined;
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (
      input.fileName !== path.basename(input.fileName) ||
      path.extname(input.fileName).toLowerCase() !== ".html"
    ) {
      return yield* Effect.fail("Invalid Pi export filename.");
    }
    const canonicalPath = yield* fileSystem.realPath(input.canonicalPath);
    if (canonicalPath !== input.canonicalPath || path.basename(canonicalPath) !== input.fileName) {
      return yield* Effect.fail("Invalid Pi export path.");
    }
    unregisteredDirectory = path.dirname(canonicalPath);
    const info = yield* fileSystem.stat(canonicalPath);
    if (info.type !== "File") return yield* Effect.fail("Invalid Pi export file.");

    const crypto = yield* Crypto.Crypto;
    const handle = yield* crypto.randomUUIDv4;
    const expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
    const artifact = {
      canonicalPath,
      directory: path.dirname(canonicalPath),
      fileName: input.fileName,
      expiresAt,
    } satisfies ExportArtifact;
    const claims: AssetClaims = { version: 1, kind: "pi-html-export", handle, expiresAt };
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
    const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
    const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;

    yield* exportArtifactLock.withPermit(
      Effect.gen(function* () {
        while (exportArtifacts.size >= PI_EXPORT_ARTIFACT_LIMIT) {
          const oldest = exportArtifacts.entries().next().value;
          if (oldest === undefined) break;
          const [oldestHandle, oldestArtifact] = oldest;
          yield* fileSystem.remove(oldestArtifact.directory, { recursive: true, force: true });
          exportArtifacts.delete(oldestHandle);
        }
        exportArtifacts.set(handle, artifact);
        unregisteredDirectory = undefined;
      }),
    );
    return {
      handle,
      fileName: input.fileName,
      relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(input.fileName)}`,
      expiresAt,
    };
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => {
        const directory = unregisteredDirectory;
        return directory === undefined
          ? Effect.void
          : FileSystem.FileSystem.pipe(
              Effect.flatMap((fileSystem) =>
                fileSystem.remove(directory, { recursive: true, force: true }),
              ),
              Effect.catch(() =>
                Effect.sync(() => {
                  pendingExportCleanup.add(directory);
                }),
              ),
            );
      }),
    ),
  );
};

export const resolveAsset = Effect.fn("AssetAccess.resolveAsset")(function* (
  token: string,
  relativePath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => null),
  );
  if (!signingSecret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) return null;

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

  if (claims.kind === "pi-html-export") {
    const artifact = exportArtifacts.get(claims.handle);
    if (!artifact || artifact.expiresAt !== claims.expiresAt) return null;
    const decodedPath = decodeRelativePath(relativePath);
    if (decodedPath !== artifact.fileName) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const canonicalPath = yield* optionOnNotFound(fileSystem.realPath(artifact.canonicalPath)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    const info = yield* optionOnNotFound(fileSystem.stat(artifact.canonicalPath)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(canonicalPath) &&
      canonicalPath.value === artifact.canonicalPath &&
      Option.isSome(info) &&
      info.value.type === "File"
      ? ({
          kind: "file",
          path: artifact.canonicalPath,
          downloadName: artifact.fileName,
        } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "attachment") {
    const config = yield* ServerConfig.ServerConfig;
    const attachmentPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: claims.attachmentId,
    });
    if (!attachmentPath) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* optionOnNotFound(fileSystem.stat(attachmentPath)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to inspect attachment asset.", {
          attachmentId: claims.attachmentId,
          path: attachmentPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({ kind: "file", path: attachmentPath } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "project-favicon") {
    if (claims.relativePath === null) return null;
    const faviconPath = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return faviconPath ? ({ kind: "file", path: faviconPath } satisfies ResolvedAsset) : null;
  }

  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  const path = yield* Path.Path;
  if (claims.kind === "workspace-file-exact") {
    if (decodedPath !== path.basename(claims.relativePath)) return null;
    const exactWorkspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return exactWorkspaceFile
      ? ({ kind: "file", path: exactWorkspaceFile } satisfies ResolvedAsset)
      : null;
  }
  const segments = decodedPath.split(/[\\/]/);
  if (
    decodedPath.length === 0 ||
    decodedPath.includes("\0") ||
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
    !PREVIEW_ASSET_EXTENSIONS.has(path.extname(decodedPath).toLowerCase())
  ) {
    return null;
  }
  const joinedRelativePath =
    claims.baseRelativePath === "." ? decodedPath : path.join(claims.baseRelativePath, decodedPath);
  const workspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
    workspaceRoot: claims.workspaceRoot,
    relativePath: joinedRelativePath,
  });
  return workspaceFile ? ({ kind: "file", path: workspaceFile } satisfies ResolvedAsset) : null;
});
