import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="void">
      <h1>Nothing here</h1>
      <p>
        That URL is not a match. <Link to="/">Back to Worlds</Link>.
      </p>
    </section>
  );
}
