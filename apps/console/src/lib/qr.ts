import qrcode from "qrcode-generator";

/** Blank modules around the code. The QR spec asks for four; phone cameras fail without them. */
export const QUIET_ZONE = 4;

/** Row-major grid of modules: true is dark. */
export type QrMatrix = readonly (readonly boolean[])[];

export interface QrPath {
  /** Side of the square viewBox, in modules, quiet zone included. */
  readonly viewBox: number;
  /** One path of unit squares, one per dark module. */
  readonly d: string;
}

/**
 * The text a terminal accepts for enrollment: the one-time code itself. The POS setup screen types the code in
 * and normalises it on the server, so the QR encodes exactly that, never a URL or a prefixed form.
 */
export function enrollmentPayload(code: string): string {
  return code.trim();
}

/** Error correction M, automatic version. Pure: the same text always gives the same matrix. */
export function qrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => qr.isDark(row, col)),
  );
}

/** SVG geometry for a matrix. Each dark module is one unit square, so the image scales without blur. */
export function qrPath(matrix: QrMatrix, quiet: number = QUIET_ZONE): QrPath {
  let d = "";
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) d += `M${String(c + quiet)} ${String(r + quiet)}h1v1h-1z`;
    });
  });
  return { viewBox: matrix.length + quiet * 2, d };
}
