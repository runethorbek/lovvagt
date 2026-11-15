import { site } from "@/lib/site";

export default function HomePage() {
  return (
    <main>
      <h1>{site.name}</h1>
      <p>{site.description}</p>
    </main>
  );
}
