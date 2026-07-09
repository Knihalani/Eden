/**
 * SDK version pulled from package.json at build time.
 *
 * ``resolveJsonModule`` is enabled in tsconfig so this is a literal
 * tree-shake-able constant in the emitted bundle (no runtime fs
 * reads). Keeping it in one place means the User-Agent header and
 * any diagnostic stamps can never drift apart from the published
 * version again.
 */
import pkg from "../package.json";

export const SDK_NAME = "@eden-ai/sdk";
export const SDK_VERSION: string = (pkg as { version: string }).version;
export const SDK_USER_AGENT = `${SDK_NAME}/${SDK_VERSION}`;
