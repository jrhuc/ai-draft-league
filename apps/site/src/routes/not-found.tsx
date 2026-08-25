import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="void">
      <h1>Nothing here</h1>
      <p>
        That page is not part of this season. <Link to="/">Back to standings</Link>.
      </p>
    </section>
  );
}
