import { NavLink } from "@/components/nav-link";
import { useExternalRuns } from "@/lib/runs";
import "@/styles/watch.css";

export default function DevNav() {
  const { runs } = useExternalRuns(15_000);
  const onAir = runs?.some((run) => run.state === "running") ?? false;
  return (
    <>
      <NavLink href="/live">
        Live
        {onAir ? <span className="on-air" aria-label="A run is in progress" /> : null}
      </NavLink>
      <NavLink href="/archive">Archive</NavLink>
    </>
  );
}
