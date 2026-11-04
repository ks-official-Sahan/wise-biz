import s from "./auth.module.css";

import type { ReactNode } from "react";

export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return (
    <main className={s.shell}>
      <div className={s.panel}>
        <div className={s.brand}>
          <span aria-hidden className={s.mark} />
          wise-biz
        </div>
        {children}
      </div>
    </main>
  );
}
