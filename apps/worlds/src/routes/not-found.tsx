import { Link } from "react-router-dom";
import { useTitle } from "@/lib/context";

export function NotFoundPage() {
  useTitle("Page not found");
  return (
    <section className="void">
      <h1 tabIndex={-1}>Page not found</h1>
      <p>
        This page does not exist. <Link to="/">Back to the bracket</Link>.
      </p>
    </section>
  );
}
