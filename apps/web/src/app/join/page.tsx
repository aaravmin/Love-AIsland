import { Suspense } from "react";
import { JoinForm } from "./join-form";

// useSearchParams (read in JoinForm) requires a Suspense boundary around it
// or the production build fails -- see next/dist/docs/01-app/03-api-reference/
// 04-functions/use-search-params.md ("Missing Suspense boundary" build error).
export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinForm />
    </Suspense>
  );
}
