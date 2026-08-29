import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="void">
      <h1>Page not found</h1>
      <p>
        This match does not exist. <Link to="/">Back to the bracket</Link>.
      </p>
    </section>
  );
}
