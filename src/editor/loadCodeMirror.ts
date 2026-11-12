export let codeMirror: typeof import("./codeMirror.ts") | undefined;
let loading: Promise<void> | undefined;
export function loadCodeMirror() { return loading ??= import("./codeMirror.ts").then(module => { codeMirror = module; }); }
