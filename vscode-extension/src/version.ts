/** The extension's version, stamped by the esbuild bundle (`define`); `0.0.0-dev` from source. */
declare const __HQ_VSCODE_VERSION__: string | undefined;

export const EXTENSION_VERSION: string =
  typeof __HQ_VSCODE_VERSION__ === 'string' && __HQ_VSCODE_VERSION__.length > 0
    ? __HQ_VSCODE_VERSION__
    : '0.0.0-dev';
