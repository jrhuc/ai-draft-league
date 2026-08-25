import { Link, useLocation } from "react-router-dom";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const { pathname } = useLocation();
  const current = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link to={href} aria-current={current ? "page" : undefined} viewTransition>
      {children}
    </Link>
  );
}
