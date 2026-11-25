import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/** Serves the UI and its Java model on loopback only. Requires Java 17 or newer. */
public final class NoiseServer {
    private static final int DEFAULT_PORT = 8765;
    private static final Map<String, String> ASSETS = Map.of(
            "/", "index.html", "/index.html", "index.html", "/style.css", "style.css", "/app.js", "app.js");
    private final NoiseMeter meter = new NoiseMeter();
    private final long started = System.nanoTime();
    private final int port;

    private NoiseServer(int port) {
        this.port = port;
    }

    public static void main(String[] args) throws IOException {
        int port = args.length == 0 ? DEFAULT_PORT : Integer.parseInt(args[0]);
        NoiseServer app = new NoiseServer(port);
        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        http.createContext("/", app::handle);
        http.setExecutor(Executors.newFixedThreadPool(4));
        http.start();
        System.out.printf("Classroom Noise Meter%nOpen http://localhost:%d/ in desktop Chrome or Edge.%n", port);
        System.out.println("Keep this window open during use. Press Ctrl+C to stop.");
    }

    private void handle(HttpExchange request) throws IOException {
        try (request) {
            String host = request.getRequestHeaders().getFirst("Host");
            if (!("localhost:" + port).equalsIgnoreCase(host) && !("127.0.0.1:" + port).equals(host)) {
                sendText(request, 403, "Open this application on localhost.");
                return;
            }
            String path = request.getRequestURI().getPath();
            String method = request.getRequestMethod();
            boolean stateRequest = path.equals("/api/state") && method.equals("GET");
            boolean commandRequest = path.equals("/api/command") && method.equals("POST");
            if (stateRequest || commandRequest) {
                if (commandRequest && !("http://" + host).equals(request.getRequestHeaders().getFirst("Origin"))) {
                    sendText(request, 403, "This command must come from the local application page.");
                    return;
                }
                handleApi(request, stateRequest);
                return;
            }
            if (method.equals("GET") && ASSETS.containsKey(path)) {
                serveAsset(request, ASSETS.get(path));
                return;
            }
            sendText(request, 404, "Page not found.");
        }
    }

    private void handleApi(HttpExchange request, boolean stateRequest) throws IOException {
        try {
            Map<String, String> fields = new HashMap<>();
            String query = request.getRequestURI().getRawQuery();
            if (query != null && query.length() > 512) throw new IllegalArgumentException("Request is too large.");
            if (query != null) {
                for (String field : query.split("&")) {
                    String[] pair = field.split("=", 2);
                    if (pair.length == 2) fields.put(pair[0], URLDecoder.decode(pair[1], StandardCharsets.UTF_8));
                }
            }
            String client = fields.getOrDefault("client", "");
            if (!client.matches("[a-z0-9-]{8,48}")) throw new IllegalArgumentException("Invalid tab ID.");
            String action = stateRequest ? "state" : fields.getOrDefault("action", "");
            int low = 0;
            int high = 0;
            int selector = -1;
            if (action.equals("frame")) {
                low = Integer.parseInt(fields.getOrDefault("low", "-1"));
                high = Integer.parseInt(fields.getOrDefault("high", "-1"));
                selector = Integer.parseInt(fields.getOrDefault("selector", "-1"));
            }
            long now = (System.nanoTime() - started) / 1_000_000L;
            String json = meter.apply(action, client, fields.getOrDefault("value", ""), low, high, selector, now);
            send(request, 200, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException badRequest) {
            sendText(request, 400, badRequest.getMessage());
        } catch (IllegalStateException conflict) {
            sendText(request, 409, conflict.getMessage());
        }
    }

    private void serveAsset(HttpExchange request, String name) throws IOException {
        try (InputStream stream = NoiseServer.class.getResourceAsStream("/web/" + name)) {
            if (stream == null) {
                sendText(request, 500, "Bundled web asset is unavailable.");
                return;
            }
            String contentType = switch (name) {
                case "style.css" -> "text/css";
                case "app.js" -> "text/javascript";
                default -> "text/html";
            };
            request.getResponseHeaders().set("Content-Security-Policy",
                    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
            send(request, 200, contentType + "; charset=utf-8", stream.readAllBytes());
        }
    }

    private static void sendText(HttpExchange request, int status, String text) throws IOException {
        send(request, status, "text/plain; charset=utf-8", text.getBytes(StandardCharsets.UTF_8));
    }

    private static void send(HttpExchange request, int status, String type, byte[] bytes) throws IOException {
        request.getResponseHeaders().set("Content-Type", type);
        request.getResponseHeaders().set("Cache-Control", "no-store");
        request.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        request.sendResponseHeaders(status, bytes.length);
        request.getResponseBody().write(bytes);
    }
}
