// Applies the saved theme before the first paint. A file, not an inline
// script, so the site's content security policy can forbid inline scripts.
try {
  const saved = localStorage.getItem("tandem-theme");
  const dark = saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
