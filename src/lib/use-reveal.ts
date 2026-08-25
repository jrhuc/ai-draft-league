import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Arms a shared IntersectionObserver over the direct children of `.page` so
 * every page section reveals once as it enters the viewport. Sections already
 * visible on arrival are revealed immediately with a small stagger; sections
 * below the fold reveal without delay as they are scrolled to. Re-armed on
 * every route change; fully inert when IntersectionObserver is unavailable
 * (the CSS `.no-io` escape hatch keeps content visible).
 */
export function useReveal(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const page = document.querySelector(".page");
    if (!page) return;
    if (typeof IntersectionObserver === "undefined") {
      document.documentElement.classList.add("no-io");
      return;
    }
    // SAFETY: .page's direct children are route-rendered sections; element children of a
    // known container are HTMLElements, and non-elements would only fail class toggling harmlessly.
    const children = Array.from(page.children) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    const viewport = window.innerHeight;
    children.forEach((child, index) => {
      child.classList.add("reveal");
      if (child.getBoundingClientRect().top < viewport)
        child.style.setProperty("--reveal-delay", `${Math.min(index * 45, 270)}ms`);
      io.observe(child);
    });
    return () => {
      io.disconnect();
      for (const child of children) {
        child.classList.remove("reveal", "in");
        child.style.removeProperty("--reveal-delay");
      }
    };
  }, [pathname]);
}
