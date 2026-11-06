import { redirect } from "react-router";

/** During the Philippines launch, the global entry point opens the Philippines experience (no IP geolocation). */
export function loader() {
  return redirect("/ph", 302);
}

export default function RootRedirect() {
  return null;
}
