import { Suspense } from "react";
import SignInForm from "./SignInForm";

/**
 * Sign-in page. The client form is wrapped in Suspense because it reads the
 * `next` search parameter (redirect target after a middleware bounce).
 */
export default function SignInPage() {
  return (
    <Suspense fallback={<main style={{ padding: "2rem" }}>{null}</main>}>
      <SignInForm />
    </Suspense>
  );
}
