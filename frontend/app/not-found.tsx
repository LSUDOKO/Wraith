import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell notfound">
      <p className="notfound-code">404</p>
      <h1 className="notfound-title">Nothing sealed here</h1>
      <p className="notfound-body">
        This page does not exist. The order you are looking for may have been executed, cancelled, or never
        created.
      </p>
      <Link className="notfound-link" href="/">
        Back to orders
      </Link>
    </main>
  );
}
