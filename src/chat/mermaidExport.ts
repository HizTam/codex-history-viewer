import { Buffer } from "node:buffer";

export type MermaidExportFormat = "svg" | "png" | "mmd";
export type MermaidExportScope = "message" | "card";

export interface MermaidExportIdentity {
  diagramOrdinal: number;
  diagramScope: MermaidExportScope;
  diagramScopeNumber: number;
}

export interface MermaidExportRequest extends MermaidExportIdentity {
  format: MermaidExportFormat;
  payload: string;
}

export interface ValidatedMermaidExport extends MermaidExportIdentity {
  bytes: Uint8Array;
  extension: ".svg" | ".png" | ".mmd";
  format: MermaidExportFormat;
}

const MAX_DIAGRAM_SCOPE_NUMBER = 999_999_999;
const MAX_DIAGRAM_ORDINAL = 999;
const MAX_SVG_BYTES = 5 * 1024 * 1024;
const MAX_SVG_ELEMENTS = 100_000;
const MAX_SVG_DEPTH = 512;
const MAX_SVG_ATTRIBUTES_PER_ELEMENT = 1_024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const MAX_PNG_DIMENSION = 8192;
const MAX_PNG_PIXELS = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const PNG_DATA_URI_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const UNSAFE_SVG_ELEMENTS = new Set([
  "a",
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "image",
  "audio",
  "video",
  "base",
  "discard",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "handler",
]);
const CSS_PRESENTATION_ATTRIBUTES = new Set([
  "clip-path",
  "color",
  "cursor",
  "fill",
  "filter",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "stroke",
]);
const XML_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u;
const INTERNAL_FRAGMENT_PATTERN = /^#[A-Za-z0-9_.:-]+$/u;

interface SvgElementFrame {
  readonly name: string;
  readonly localName: string;
  styleText: string;
}

interface ParsedSvgStartTag {
  readonly name: string;
  readonly localName: string;
  readonly selfClosing: boolean;
}

export function validateMermaidExportRequest(value: unknown): ValidatedMermaidExport | undefined {
  if (!isRecord(value)) return undefined;

  const format = value.format;
  const payload = value.payload;
  const diagramOrdinal = value.diagramOrdinal;
  const diagramScope = value.diagramScope;
  const diagramScopeNumber = value.diagramScopeNumber;
  if (
    (format !== "svg" && format !== "png" && format !== "mmd") ||
    (diagramScope !== "message" && diagramScope !== "card") ||
    typeof payload !== "string" ||
    typeof diagramScopeNumber !== "number" ||
    !Number.isSafeInteger(diagramScopeNumber) ||
    diagramScopeNumber < 1 ||
    diagramScopeNumber > MAX_DIAGRAM_SCOPE_NUMBER ||
    typeof diagramOrdinal !== "number" ||
    !Number.isSafeInteger(diagramOrdinal) ||
    diagramOrdinal < 1 ||
    diagramOrdinal > MAX_DIAGRAM_ORDINAL
  ) {
    return undefined;
  }
  const identity: MermaidExportIdentity = { diagramOrdinal, diagramScope, diagramScopeNumber };

  if (format === "svg") {
    const bytes = Buffer.from(payload, "utf8");
    if (
      bytes.length < 1 ||
      bytes.length > MAX_SVG_BYTES ||
      payload.includes("\0") ||
      /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(payload) ||
      !isSafeMermaidSvgDocument(payload)
    ) {
      return undefined;
    }
    return { bytes, ...identity, extension: ".svg", format };
  }

  if (format === "mmd") {
    const bytes = Buffer.from(payload, "utf8");
    if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES || payload.includes("\0") || !payload.trim()) {
      return undefined;
    }
    return { bytes, ...identity, extension: ".mmd", format };
  }

  if (!payload.startsWith(PNG_DATA_URI_PREFIX)) return undefined;
  const encoded = payload.slice(PNG_DATA_URI_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4 || !isCanonicalBase64(encoded)) {
    return undefined;
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < PNG_SIGNATURE.length || bytes.length > MAX_PNG_BYTES) return undefined;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
  if (!hasSafePngDimensions(bytes)) return undefined;
  return { bytes, ...identity, extension: ".png", format };
}

export function buildMermaidExportFileName(
  identity: MermaidExportIdentity,
  extension: ValidatedMermaidExport["extension"],
): string {
  const { diagramOrdinal, diagramScope, diagramScopeNumber } = identity;
  const safeScope = diagramScope === "card" ? "card" : "message";
  const safeScopeNumber =
    Number.isSafeInteger(diagramScopeNumber) &&
    diagramScopeNumber >= 1 &&
    diagramScopeNumber <= MAX_DIAGRAM_SCOPE_NUMBER
      ? diagramScopeNumber
      : 1;
  const safeOrdinal =
    Number.isSafeInteger(diagramOrdinal) &&
    diagramOrdinal >= 1 &&
    diagramOrdinal <= MAX_DIAGRAM_ORDINAL
      ? diagramOrdinal
      : 1;
  const scopeNumberText = String(safeScopeNumber).padStart(5, "0");
  const ordinalText = String(safeOrdinal).padStart(2, "0");
  const scopeSegment = safeScope === "card" ? `card-${scopeNumberText}` : scopeNumberText;
  return `mermaid-diagram-${scopeSegment}-${ordinalText}${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeMermaidSvgDocument(svg: string): boolean {
  const stack: SvgElementFrame[] = [];
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;
  let elementCount = 0;

  while (cursor < svg.length) {
    if (svg[cursor] !== "<") {
      const nextTag = svg.indexOf("<", cursor);
      const end = nextTag >= 0 ? nextTag : svg.length;
      const text = svg.slice(cursor, end);
      const decodedText = decodeXmlEntities(text);
      if (decodedText === undefined || text.includes("]]>")) return false;
      if (stack.length === 0) {
        if (decodedText.trim()) return false;
      } else if (stack[stack.length - 1]?.localName === "style") {
        stack[stack.length - 1].styleText += decodedText;
      }
      cursor = end;
      continue;
    }

    if (svg.startsWith("<!", cursor) || svg.startsWith("<?", cursor)) return false;
    const tagEnd = findXmlTagEnd(svg, cursor + 1);
    if (tagEnd < 0) return false;
    const rawTag = svg.slice(cursor + 1, tagEnd).trim();
    if (!rawTag) return false;

    if (rawTag.startsWith("/")) {
      const closingName = rawTag.slice(1).trim();
      if (!XML_NAME_PATTERN.test(closingName)) return false;
      const frame = stack.pop();
      if (!frame || frame.name !== closingName) return false;
      if (frame.localName === "style" && !isSafeSvgCss(frame.styleText)) return false;
      if (stack.length === 0) rootClosed = true;
    } else {
      if (rootClosed || stack[stack.length - 1]?.localName === "style") return false;
      const parsedTag = parseSvgStartTag(rawTag);
      if (!parsedTag || UNSAFE_SVG_ELEMENTS.has(parsedTag.localName)) return false;
      elementCount += 1;
      if (elementCount > MAX_SVG_ELEMENTS || stack.length >= MAX_SVG_DEPTH) return false;
      if (stack.length === 0) {
        if (rootSeen || parsedTag.name !== "svg") return false;
        rootSeen = true;
      }
      if (parsedTag.selfClosing) {
        if (stack.length === 0) rootClosed = true;
      } else {
        stack.push({ name: parsedTag.name, localName: parsedTag.localName, styleText: "" });
      }
    }
    cursor = tagEnd + 1;
  }

  return rootSeen && rootClosed && stack.length === 0;
}

function findXmlTagEnd(svg: string, start: number): number {
  let quote = "";
  for (let index = start; index < svg.length; index += 1) {
    const character = svg[index] ?? "";
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

function parseSvgStartTag(rawTag: string): ParsedSvgStartTag | undefined {
  let body = rawTag;
  let selfClosing = false;
  if (/\/\s*$/u.test(body)) {
    selfClosing = true;
    body = body.replace(/\/\s*$/u, "");
  }

  let cursor = 0;
  while (cursor < body.length && !/\s/u.test(body[cursor] ?? "")) cursor += 1;
  const name = body.slice(0, cursor);
  if (!XML_NAME_PATTERN.test(name)) return undefined;
  const localName = getXmlLocalName(name);
  const attributeNames = new Set<string>();

  while (cursor < body.length) {
    while (cursor < body.length && /\s/u.test(body[cursor] ?? "")) cursor += 1;
    if (cursor >= body.length) break;

    const nameStart = cursor;
    while (cursor < body.length && !/[\s=]/u.test(body[cursor] ?? "")) cursor += 1;
    const attributeName = body.slice(nameStart, cursor);
    if (!XML_NAME_PATTERN.test(attributeName) || attributeNames.has(attributeName)) return undefined;
    attributeNames.add(attributeName);
    if (attributeNames.size > MAX_SVG_ATTRIBUTES_PER_ELEMENT) return undefined;

    while (cursor < body.length && /\s/u.test(body[cursor] ?? "")) cursor += 1;
    if (body[cursor] !== "=") return undefined;
    cursor += 1;
    while (cursor < body.length && /\s/u.test(body[cursor] ?? "")) cursor += 1;

    const quote = body[cursor];
    if (quote !== '"' && quote !== "'") return undefined;
    cursor += 1;
    const valueStart = cursor;
    while (cursor < body.length && body[cursor] !== quote) cursor += 1;
    if (cursor >= body.length) return undefined;
    const rawValue = body.slice(valueStart, cursor);
    cursor += 1;
    if (rawValue.includes("<")) return undefined;

    const decodedValue = decodeXmlEntities(rawValue);
    if (decodedValue === undefined || !isSafeSvgAttribute(attributeName, decodedValue)) return undefined;
  }

  return { name, localName, selfClosing };
}

function getXmlLocalName(name: string): string {
  const separator = name.lastIndexOf(":");
  return name.slice(separator + 1).toLowerCase();
}

function isSafeSvgAttribute(name: string, value: string): boolean {
  const localName = getXmlLocalName(name);
  if (localName.startsWith("on")) return false;
  if (localName === "base" || localName === "ping") return false;
  if (localName === "href" || localName === "src") {
    return INTERNAL_FRAGMENT_PATTERN.test(value.trim());
  }
  if (localName === "style" || CSS_PRESENTATION_ATTRIBUTES.has(localName)) {
    return isSafeSvgCss(value);
  }
  return true;
}

function isSafeSvgCss(css: string): boolean {
  if (
    css.includes("\\") ||
    css.includes("/*") ||
    css.includes("*/") ||
    css.includes("//") ||
    /javascript\s*:|expression\s*\(|@import\b/iu.test(css) ||
    /@font-face\b|\b(?:-webkit-)?image-set\s*\(|\bcross-fade\s*\(|\bpaint\s*\(/iu.test(css) ||
    /["']\s*\//u.test(css) ||
    /\b(?:blob|data|file|ftp|https?|vscode(?:-webview)?):/iu.test(css)
  ) {
    return false;
  }

  const urlPattern = /url\s*\(/giu;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(css)) !== null) {
    const closingIndex = css.indexOf(")", urlPattern.lastIndex);
    if (closingIndex < 0) return false;
    let reference = css.slice(urlPattern.lastIndex, closingIndex).trim();
    if (
      (reference.startsWith('"') && reference.endsWith('"')) ||
      (reference.startsWith("'") && reference.endsWith("'"))
    ) {
      reference = reference.slice(1, -1).trim();
    } else if (reference.includes('"') || reference.includes("'")) {
      return false;
    }
    if (!INTERNAL_FRAGMENT_PATTERN.test(reference)) return false;
    urlPattern.lastIndex = closingIndex + 1;
  }
  return true;
}

function decodeXmlEntities(value: string): string | undefined {
  let cursor = 0;
  let decoded = "";
  while (cursor < value.length) {
    const entityStart = value.indexOf("&", cursor);
    if (entityStart < 0) return decoded + value.slice(cursor);
    decoded += value.slice(cursor, entityStart);
    const entityEnd = value.indexOf(";", entityStart + 1);
    if (entityEnd < 0 || entityEnd - entityStart > 16) return undefined;
    const entity = value.slice(entityStart + 1, entityEnd);
    const character = decodeXmlEntity(entity);
    if (character === undefined) return undefined;
    decoded += character;
    cursor = entityEnd + 1;
  }
  return decoded;
}

function decodeXmlEntity(entity: string): string | undefined {
  const predefined: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  if (Object.prototype.hasOwnProperty.call(predefined, entity)) return predefined[entity];

  const numericMatch = /^#(?:x([0-9a-f]+)|([0-9]+))$/iu.exec(entity);
  if (!numericMatch) return undefined;
  const codePoint = Number.parseInt(numericMatch[1] ?? numericMatch[2] ?? "", numericMatch[1] ? 16 : 10);
  if (!isValidXmlCodePoint(codePoint)) return undefined;
  return String.fromCodePoint(codePoint);
}

function isValidXmlCodePoint(value: number): boolean {
  return (
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0d ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const paddingIndex = value.indexOf("=");
  return paddingIndex < 0 || paddingIndex >= value.length - 2;
}

function hasSafePngDimensions(bytes: Buffer): boolean {
  if (bytes.length < 24 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    return false;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return (
    width >= 1 &&
    height >= 1 &&
    width <= MAX_PNG_DIMENSION &&
    height <= MAX_PNG_DIMENSION &&
    width * height <= MAX_PNG_PIXELS
  );
}
