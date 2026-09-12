import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function renderPdfFirstPage(pdf: Buffer): Promise<Buffer> {
  if (!pdf.length || !pdf.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new Error("INVALID_PDF_HEADER");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "openbot-pdf-"));
  const inputPath = path.join(directory, "receipt.pdf");
  const outputPrefix = path.join(directory, "receipt-preview");
  try {
    await writeFile(inputPath, pdf, { mode: 0o600 });
    await execFileAsync("pdftoppm", [
      "-f", "1", "-l", "1", "-singlefile", "-png", "-scale-to", "1600",
      inputPath, outputPrefix,
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const preview = await readFile(`${outputPrefix}.png`);
    if (!preview.length) throw new Error("PDF_PREVIEW_EMPTY");
    return preview;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
