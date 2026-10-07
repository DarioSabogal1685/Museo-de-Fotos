import {
	createRoom,
	getPhotoContent,
	getPhotoThumbnail,
	listPhotos,
	getGroups,
	listRooms,
	listTagSuggestions,
	replacePhoto,
	saveGroups,
	sanitizeGroups,
	sanitizeTags,
	trashPhoto,
	updatePhotoMeta,
	uploadPhoto,
} from "./drive";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

function corsHeaders(env: Env): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
		"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		Vary: "Origin",
	};
}

function json(env: Env, data: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return Response.json(data, { status, headers: { ...corsHeaders(env), ...extra } });
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
	const header = request.headers.get("Authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	const enc = new TextEncoder();
	// Se comparan los hashes para tener siempre la misma longitud y evitar fugas de tiempo.
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(token)),
		crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_TOKEN)),
	]);
	return env.ADMIN_TOKEN.length > 0 && crypto.subtle.timingSafeEqual(a, b);
}

/** Sirve una imagen desde la cache de Cloudflare o la pide a Drive y la guarda. */
async function cachedImage(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	load: () => Promise<Response | null>,
): Promise<Response> {
	const cache = caches.default;
	const cacheKey = new Request(request.url, { method: "GET" });
	const hit = await cache.match(cacheKey);
	if (hit) return hit;

	const origin = await load();
	if (!origin) return json(env, { error: "Foto no encontrada" }, 404);

	const headers = new Headers(origin.headers);
	for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
	headers.set("Cache-Control", "public, max-age=86400");
	const response = new Response(origin.body, { status: 200, headers });
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const { pathname } = url;

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders(env) });
	}

	if (pathname === "/api/rooms" && request.method === "GET") {
		return json(env, await listRooms(env), 200, { "Cache-Control": "public, max-age=60" });
	}

	if (pathname === "/api/groups" && request.method === "GET") {
		return json(env, await getGroups(env), 200, { "Cache-Control": "no-cache" });
	}

	if (pathname === "/api/groups" && request.method === "PUT") {
		if (!(await isAdmin(request, env))) return json(env, { error: "No autorizado" }, 401);
		const body = (await request.json().catch(() => null)) as { groups?: unknown } | null;
		const groups = sanitizeGroups(body?.groups);
		if (!groups) return json(env, { error: "Grupos no validos" }, 400);
		return json(env, await saveGroups(env, groups));
	}

	if (pathname === "/api/tags" && request.method === "GET") {
		return json(env, await listTagSuggestions(env), 200, { "Cache-Control": "public, max-age=30" });
	}

	if (pathname === "/api/rooms" && request.method === "POST") {
		if (!(await isAdmin(request, env))) return json(env, { error: "No autorizado" }, 401);
		const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
		const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
		if (!name) return json(env, { error: "Falta el nombre del cuarto" }, 400);
		return json(env, await createRoom(env, name), 201);
	}

	const roomMatch = pathname.match(/^\/api\/rooms\/([\w-]+)\/photos$/);
	if (roomMatch) {
		const roomId = roomMatch[1];

		if (request.method === "GET") {
			const photos = await listPhotos(env, roomId);
			if (!photos) return json(env, { error: "Cuarto no encontrado" }, 404);
			return json(env, photos, 200, { "Cache-Control": "public, max-age=60" });
		}

		if (request.method === "POST") {
			if (!(await isAdmin(request, env))) return json(env, { error: "No autorizado" }, 401);
			const length = Number(request.headers.get("Content-Length") ?? 0);
			if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
				return json(env, { error: "Archivo demasiado grande (maximo 25 MB)" }, 413);
			}
			const form = await request.formData();
			const file = form.get("file");
			if (!(file instanceof File)) return json(env, { error: "Falta el campo 'file'" }, 400);
			if (!ALLOWED_TYPES.has(file.type)) return json(env, { error: "Tipo de imagen no permitido" }, 415);
			if (file.size > MAX_UPLOAD_BYTES) {
				return json(env, { error: "Archivo demasiado grande (maximo 25 MB)" }, 413);
			}
			const photo = await uploadPhoto(env, roomId, file);
			if (!photo) return json(env, { error: "Cuarto no encontrado" }, 404);
			return json(env, photo, 201);
		}
	}

	const match = pathname.match(/^\/api\/photos\/([\w-]+)(\/thumb)?$/);
	if (match) {
		const id = match[1];
		const isThumb = Boolean(match[2]);

		if (request.method === "GET") {
			if (isThumb) {
				const requested = Number(url.searchParams.get("w") ?? 400);
				const width = Math.min(Math.max(Number.isFinite(requested) ? requested : 400, 100), 1600);
				return cachedImage(request, env, ctx, () => getPhotoThumbnail(env, id, width));
			}
			return cachedImage(request, env, ctx, () => getPhotoContent(env, id));
		}

		// Cambiar nombre y/o etiquetas: PATCH con JSON { name?, tags? }.
		if (request.method === "PATCH" && !isThumb) {
			if (!(await isAdmin(request, env))) return json(env, { error: "No autorizado" }, 401);
			const body = (await request.json().catch(() => null)) as { name?: unknown; tags?: unknown } | null;
			const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
			const tags = body?.tags === undefined ? undefined : sanitizeTags(body.tags);
			if (body?.tags !== undefined && !tags) return json(env, { error: "Etiquetas no validas" }, 400);
			if (!name && !tags) return json(env, { error: "Nada que actualizar" }, 400);
			const photo = await updatePhotoMeta(env, id, { name: name || undefined, tags: tags ?? undefined });
			return photo ? json(env, photo) : json(env, { error: "Foto no encontrada" }, 404);
		}

		// Reemplazar la imagen: PUT con formulario { file, name? }.
		if (request.method === "PUT" && !isThumb) {
			if (!(await isAdmin(request, env))) return json(env, { error: "No autorizado" }, 401);
			const length = Number(request.headers.get("Content-Length") ?? 0);
			if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
				return json(env, { error: "Archivo demasiado grande (maximo 25 MB)" }, 413);
			}
			const form = await request.formData();
			const file = form.get("file");
			const rawName = form.get("name");
			if (!(file instanceof File)) return json(env, { error: "Falta el campo 'file'" }, 400);
			if (!ALLOWED_TYPES.has(file.type)) return json(env, { error: "Tipo de imagen no permitido" }, 415);
			if (file.size > MAX_UPLOAD_BYTES) {
				return json(env, { error: "Archivo demasiado grande (maximo 25 MB)" }, 413);
			}
			const name = typeof rawName === "string" ? rawName.trim().slice(0, 120) : "";
			const photo = await replacePhoto(env, id, file, name || undefined);
			return photo ? json(env, photo) : json(env, { error: "Foto no encontrada" }, 404);
		}

		if (request.method === "DELETE" && !isThumb) {
			if (!(await isAdmin(request, env))) return json(env, { error: "No autorizado" }, 401);
			const ok = await trashPhoto(env, id);
			return ok ? json(env, { ok: true }) : json(env, { error: "Foto no encontrada" }, 404);
		}
	}

	return json(env, { error: "No encontrado" }, 404);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await handle(request, env, ctx);
		} catch (err) {
			console.error(JSON.stringify({ message: "Error no controlado", error: String(err) }));
			return json(env, { error: "Error interno" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
