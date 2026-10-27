import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ display: "grid", gap: 12, maxWidth: 420 }}>
        <p className="muted">404</p>
        <h1>This page does not exist</h1>
        <p>It may have moved, or you may not have access to it.</p>
        <Link href="/">Go to the console home</Link>
      </div>
    </main>
  );
}
