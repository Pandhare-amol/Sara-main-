import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { getReportTemplate } from "./templates";
import type { ReportCalculation, ReportContentKind, ReportSource, ReportTable, WordReportRequest } from "./types";

const NAVY = "17365D";
const BLUE = "2F5597";
const PALE_BLUE = "D9EAF7";
const LIGHT_GRAY = "F2F2F2";
const MID_GRAY = "666666";
const WHITE = "FFFFFF";
const PAGE_WIDTH_DXA = 9026;

export async function renderWordReport(request: WordReportRequest): Promise<Buffer> {
  const template = getReportTemplate(request.templateId);
  const sources = new Map((request.sources || []).map((source) => [source.id, source]));
  const children: Array<Paragraph | Table> = [];

  children.push(
    new Paragraph({ spacing: { before: 1440 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: request.title, bold: true, color: NAVY, size: 44, font: "Aptos Display" })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 160, after: 560 }, children: [new TextRun({ text: template.name, color: BLUE, size: 26 })] }),
    controlTable(request, template.version),
    new Paragraph({ spacing: { before: 480 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: request.confidentiality!.toUpperCase(), bold: true, color: confidentialityColor(request.confidentiality!), size: 20 })] }),
    new Paragraph({ children: [new PageBreak()] }),
    heading("Contents", 1),
    new Paragraph({ text: "Report basis", style: "ContentsEntry" }),
    ...request.sections.map((section) => new Paragraph({ text: section.heading, style: "ContentsEntry", indent: { left: ((section.level || 1) - 1) * 360 } })),
  );
  if (request.calculations?.length) children.push(new Paragraph({ text: "Calculation register", style: "ContentsEntry" }));
  if (request.assumptions?.length) children.push(new Paragraph({ text: "Assumptions", style: "ContentsEntry" }));
  if (request.limitations?.length) children.push(new Paragraph({ text: "Limitations", style: "ContentsEntry" }));
  if (request.sources?.length) children.push(new Paragraph({ text: "References", style: "ContentsEntry" }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  children.push(
    heading("Report basis", 1),
    labelParagraph("Purpose", request.purpose),
    labelParagraph("Audience", request.audience),
    ...(request.scope ? [labelParagraph("Scope", request.scope)] : []),
    ...(request.reportingPeriod ? [labelParagraph("Reporting period", request.reportingPeriod)] : []),
    new Paragraph({
      spacing: { before: 160, after: 240 },
      children: [new TextRun({ text: "Content labels: ", bold: true }), new TextRun("Facts, analysis, estimates, assumptions, recommendations and conclusions are explicitly labelled where applicable. Citation markers refer to the reference list.")],
    }),
  );
  if (template.complianceDisclaimer) {
    children.push(callout("Template limitation", template.complianceDisclaimer, "FFF2CC"));
  }

  for (const section of request.sections) {
    children.push(heading(section.heading, section.level || 1));
    for (const paragraph of section.paragraphs || []) children.push(contentParagraph(paragraph.text, paragraph.kind, paragraph.evidenceIds, sources));
    for (const bullet of section.bullets || []) {
      children.push(contentParagraph(bullet.text, bullet.kind, bullet.evidenceIds, sources, bullet.level || 0));
    }
    for (const table of section.tables || []) children.push(...renderTable(table, sources));
  }

  if (request.calculations?.length) {
    children.push(heading("Calculation register", 1));
    children.push(new Paragraph({ text: "The following results were deterministically recomputed before generation. Inputs and operations are recorded for review.", spacing: { after: 180 } }));
    for (const calculation of request.calculations) children.push(...renderCalculation(calculation, sources));
  }
  if (request.assumptions?.length) {
    children.push(heading("Assumptions", 1));
    for (const item of request.assumptions) children.push(contentParagraph(item, "assumption", [], sources, 0));
  }
  if (request.limitations?.length) {
    children.push(heading("Limitations", 1));
    for (const item of request.limitations) children.push(contentParagraph(item, "analysis", [], sources, 0, "Limitation"));
  }
  if (request.sources?.length) {
    children.push(heading("References", 1));
    for (const source of request.sources) children.push(referenceParagraph(source));
  }

  const title = request.title;
  const document = new Document({
    creator: request.author,
    title,
    subject: request.purpose,
    description: `${template.name} generated from caller-supplied structured content with deterministic QA.`,
    keywords: `SARA report, ${template.domain}, ${request.templateId}`,
    styles: {
      default: {
        document: { run: { font: "Aptos", size: 22, color: "222222" }, paragraph: { spacing: { line: 276, after: 120 } } },
        title: { run: { font: "Aptos Display", size: 44, bold: true, color: NAVY } },
        heading1: { run: { font: "Aptos Display", size: 30, bold: true, color: NAVY }, paragraph: { spacing: { before: 320, after: 160 }, keepNext: true } },
        heading2: { run: { font: "Aptos Display", size: 26, bold: true, color: BLUE }, paragraph: { spacing: { before: 260, after: 120 }, keepNext: true } },
        heading3: { run: { font: "Aptos", size: 23, bold: true, color: NAVY }, paragraph: { spacing: { before: 220, after: 100 }, keepNext: true } },
      },
      paragraphStyles: [
        { id: "ContentsEntry", name: "Contents entry", basedOn: "Normal", next: "Normal", quickFormat: true, run: { color: NAVY, size: 22 }, paragraph: { spacing: { after: 80 }, border: { bottom: { color: "D9E2F3", style: BorderStyle.SINGLE, size: 2 } } } },
        { id: "Caption", name: "Caption", basedOn: "Normal", next: "Normal", quickFormat: true, run: { italics: true, color: MID_GRAY, size: 19 }, paragraph: { spacing: { before: 100, after: 80 }, keepNext: true } },
      ],
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 520, footer: 520 },
        },
      },
      headers: {
        default: new Header({ children: [new Paragraph({
          border: { bottom: { color: "B4C6E7", style: BorderStyle.SINGLE, size: 6 } },
          children: [new TextRun({ text: title, color: NAVY, size: 18 }), new TextRun({ text: `  |  ${request.version}`, color: MID_GRAY, size: 18 })],
        })] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: `${request.confidentiality}  •  Page `, color: MID_GRAY, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: MID_GRAY, size: 18 })],
        })] }),
      },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

function controlTable(request: WordReportRequest, templateVersion: string): Table {
  const rows = [
    ["Prepared for", request.audience],
    ["Purpose", request.purpose],
    ["Document date", request.documentDate!],
    ["Prepared by", request.author!],
    ["Version", request.version!],
    ["Template", `${request.templateId} v${templateVersion}`],
  ];
  if (request.reportingPeriod) rows.splice(3, 0, ["Reporting period", request.reportingPeriod]);
  return new Table({
    width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
    rows: rows.map(([label, value]) => new TableRow({ children: [
      new TableCell({ width: { size: 2200, type: WidthType.DXA }, shading: { fill: NAVY, type: ShadingType.CLEAR }, margins: cellMargins(), children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, color: WHITE })] })] }),
      new TableCell({ width: { size: PAGE_WIDTH_DXA - 2200, type: WidthType.DXA }, margins: cellMargins(), children: [new Paragraph({ text: value })] }),
    ] })),
  });
}

function heading(text: string, level: number): Paragraph {
  const headingLevel = level === 3 ? HeadingLevel.HEADING_3 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1;
  return new Paragraph({ text, heading: headingLevel });
}

function labelParagraph(label: string, value: string): Paragraph {
  return new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text: `${label}: `, bold: true, color: NAVY }), new TextRun(value)] });
}

function contentParagraph(
  text: string,
  kind: ReportContentKind,
  evidenceIds: string[] = [],
  sources: Map<string, ReportSource>,
  bulletLevel?: number,
  overrideLabel?: string,
): Paragraph {
  const label = overrideLabel || contentKindLabel(kind);
  const citations = validCitations(evidenceIds, sources);
  const children: Array<TextRun | ExternalHyperlink> = [];
  if (label) children.push(new TextRun({ text: `${label} — `, bold: true, color: kindColor(kind) }));
  children.push(new TextRun(text));
  if (citations.length) children.push(new TextRun({ text: ` [${citations.join(", ")}]`, color: BLUE, bold: true }));
  return new Paragraph({
    children,
    ...(bulletLevel !== undefined ? { bullet: { level: bulletLevel } } : {}),
    spacing: { after: 140 },
    keepLines: true,
  });
}

function renderTable(table: ReportTable, sources: Map<string, ReportSource>): Array<Paragraph | Table> {
  const citations = validCitations(table.evidenceIds || [], sources);
  const caption = `${table.title}${citations.length ? ` [${citations.join(", ")}]` : ""}`;
  const widths = evenWidths(table.headers.length);
  const header = new TableRow({
    tableHeader: true,
    children: table.headers.map((value, index) => new TableCell({
      width: { size: widths[index], type: WidthType.DXA },
      shading: { fill: NAVY, type: ShadingType.CLEAR },
      margins: cellMargins(),
      children: [new Paragraph({ children: [new TextRun({ text: value, bold: true, color: WHITE })] })],
    })),
  });
  const rows = table.rows.map((row, rowIndex) => new TableRow({
    children: row.map((value, index) => new TableCell({
      width: { size: widths[index], type: WidthType.DXA },
      shading: rowIndex % 2 === 1 ? { fill: LIGHT_GRAY, type: ShadingType.CLEAR } : undefined,
      margins: cellMargins(),
      children: [new Paragraph({ text: value })],
    })),
  }));
  return [
    new Paragraph({ text: caption, style: "Caption" }),
    new Table({ width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA }, rows: [header, ...rows] }),
    ...(table.note ? [new Paragraph({ spacing: { before: 80, after: 180 }, children: [new TextRun({ text: `Note: ${table.note}`, italics: true, color: MID_GRAY, size: 19 })] })] : []),
  ];
}

function renderCalculation(calculation: ReportCalculation, sources: Map<string, ReportSource>): Array<Paragraph | Table> {
  const citations = validCitations(calculation.evidenceIds || [], sources);
  const operation = calculation.operation.replace("_", " ");
  const result = `${formatNumber(calculation.result)}${calculation.unit ? ` ${calculation.unit}` : ""}`;
  const rows = calculation.inputs.map((input) => [input.name, formatNumber(input.value), input.unit || "—"]);
  rows.push(["Verified result", result, calculation.unit || "—"]);
  return [
    new Paragraph({ style: "Caption", children: [new TextRun({ text: `${calculation.label} (${operation})${citations.length ? ` [${citations.join(", ")}]` : ""}`, bold: true })] }),
    new Table({
      width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
      rows: [
        new TableRow({ tableHeader: true, children: ["Input", "Value", "Unit"].map((value) => new TableCell({ shading: { fill: BLUE, type: ShadingType.CLEAR }, margins: cellMargins(), children: [new Paragraph({ children: [new TextRun({ text: value, bold: true, color: WHITE })] })] })) }),
        ...rows.map((row, index) => new TableRow({ children: row.map((value) => new TableCell({ shading: index === rows.length - 1 ? { fill: PALE_BLUE, type: ShadingType.CLEAR } : undefined, margins: cellMargins(), children: [new Paragraph({ children: [new TextRun({ text: value, bold: index === rows.length - 1 })] })] })) })),
      ],
    }),
    ...(calculation.note ? [new Paragraph({ children: [new TextRun({ text: `Method note: ${calculation.note}`, italics: true, color: MID_GRAY, size: 19 })] })] : []),
  ];
}

function referenceParagraph(source: ReportSource): Paragraph {
  const lead = `[${source.id}] ${source.author ? `${source.author}. ` : ""}${source.title}.`;
  const details = [source.publisher, source.publishedAt, source.accessedAt ? `accessed ${source.accessedAt}` : "", source.note].filter(Boolean).join("; ");
  const children: Array<TextRun | ExternalHyperlink> = [new TextRun({ text: lead, bold: true, color: NAVY })];
  if (details) children.push(new TextRun(` ${details}.`));
  if (source.location) {
    if (/^https?:\/\//i.test(source.location)) {
      children.push(new TextRun(" "), new ExternalHyperlink({ link: source.location, children: [new TextRun({ text: source.location, style: "Hyperlink" })] }));
    } else {
      children.push(new TextRun({ text: ` Location: ${source.location}`, color: MID_GRAY }));
    }
  }
  return new Paragraph({ children, spacing: { after: 180 }, indent: { left: 360, hanging: 360 } });
}

function callout(title: string, text: string, fill: string): Table {
  return new Table({
    width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
    rows: [new TableRow({ children: [new TableCell({
      shading: { fill, type: ShadingType.CLEAR },
      margins: { top: 160, bottom: 160, left: 200, right: 200 },
      children: [new Paragraph({ children: [new TextRun({ text: `${title}: `, bold: true, color: NAVY }), new TextRun(text)] })],
    })] })],
  });
}

function validCitations(ids: string[], sources: Map<string, ReportSource>): string[] {
  return [...new Set(ids.filter((id) => sources.has(id)))];
}

function contentKindLabel(kind: ReportContentKind): string {
  if (kind === "fact") return "Fact";
  if (kind === "analysis") return "Analysis";
  if (kind === "estimate") return "Estimate";
  if (kind === "assumption") return "Assumption";
  if (kind === "recommendation") return "Recommendation";
  return "Conclusion";
}

function kindColor(kind: ReportContentKind): string {
  if (kind === "assumption" || kind === "estimate") return "9C5700";
  if (kind === "recommendation") return "006100";
  return BLUE;
}

function confidentialityColor(value: string): string {
  if (value === "restricted") return "9C0006";
  if (value === "confidential") return "C65911";
  if (value === "internal") return BLUE;
  return "548235";
}

function evenWidths(count: number): number[] {
  const base = Math.floor(PAGE_WIDTH_DXA / Math.max(1, count));
  return Array.from({ length: count }, (_, index) => index === count - 1 ? PAGE_WIDTH_DXA - base * (count - 1) : base);
}

function cellMargins() {
  return { top: 100, bottom: 100, left: 120, right: 120 };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 }).format(value);
}
