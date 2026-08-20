import Link from "next/link";

export default function NotFound() {
  return (
    <section className="void">
      <h1>Nothing here</h1>
      <p>
        That page is not part of this season. <Link href="/">Back to standings</Link>.
      </p>
    </section>
  );
}
