// GET /generated/<id>.png|json — saved tickets, served from the R2 bucket.
export async function onRequestGet({ params, env }) {
  const obj = await env.TICKETS.get(params.name);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}
