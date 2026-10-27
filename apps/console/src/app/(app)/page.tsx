"use client";

import Link from "next/link";

import { Card, Row, SkeletonRows, Stack, cx, styles } from "@/components/ui.tsx";
import { useBranches, useInvites, useMembers, useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

export default function HomePage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const profile = useProfile(t);
  const branches = useBranches(t);
  const members = useMembers(t);
  const invites = useInvites(t);
  const memberCount = members.data?.pages.reduce((n, p) => n + p.members.length, 0);

  const tiles = [
    {
      label: "Branches",
      value: branches.data?.filter((b) => !b.archived).length,
      href: "/settings?tab=branches",
    },
    { label: "People", value: memberCount, href: "/people" },
    { label: "Pending invites", value: invites.data?.length, href: "/people" },
  ] as const;

  return (
    <Stack>
      <div>
        <p className="muted">Welcome back</p>
        <h1>{profile.data?.name ?? tenant.name}</h1>
      </div>
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        }}
      >
        {tiles.map((tile) => (
          <Card key={tile.label}>
            <Stack>
              <span className="muted">{tile.label}</span>
              {tile.value === undefined ? (
                <SkeletonRows rows={1} label={`Loading ${tile.label.toLowerCase()}`} />
              ) : (
                <span
                  className="num"
                  style={{ fontSize: "var(--wb-font-size-2xl)", fontWeight: 600 }}
                >
                  {tile.value}
                </span>
              )}
              <Link href={tile.href as never}>Open {tile.label.toLowerCase()}</Link>
            </Stack>
          </Card>
        ))}
      </div>
      <Card>
        <Stack>
          <h2>Next steps</h2>
          <Row>
            <Link className={cx(styles.button, styles.secondary)} href={"/people?invite=1"}>
              Invite a person
            </Link>
            <Link
              className={cx(styles.button, styles.secondary)}
              href={"/settings?tab=branches&new=1"}
            >
              Add a branch
            </Link>
            <Link className={cx(styles.button, styles.secondary)} href="/audit">
              Review recent changes
            </Link>
          </Row>
          <p className="muted">Tip: press Ctrl K anywhere to jump to a page or action.</p>
        </Stack>
      </Card>
    </Stack>
  );
}
