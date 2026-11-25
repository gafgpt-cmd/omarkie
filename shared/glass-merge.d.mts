export interface InkSvgFields { parts?: { points?: { x: number; y: number }[] }[]; tool?: string; size?: number; color?: string }
export declare function inkSvg(fields: InkSvgFields): string;
