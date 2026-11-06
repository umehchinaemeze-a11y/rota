export function redirectResponse(location: string | URL, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location.toString(),
    },
  });
}
