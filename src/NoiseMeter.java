import java.time.Instant;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.Random;

/** Hardware-independent Java model. Time is monotonic milliseconds supplied by the server. */
final class NoiseMeter {
    static final int SESSION_SECONDS = 60;
    static final int EXAM_LIMIT = 30;
    static final int GROUP_WORK_LIMIT = 50;
    static final int BREAK_LIMIT = 70;
    static final int WARNING_MS = 5_000;
    private static final int DEFAULT_ALARM_GUARD_MS = 2_100;
    private static final int MAX_ALARM_GUARD_MS = 3_500;
    private static final int[] LED_LEVELS = {6, 23, 42, 62, 82};
    private static final int NOISE_FLOOR = 3;
    private static final int SMOOTHING_READINGS = 4;
    private static final int MAX_FRAME_GAP_MS = 850;
    private static final int OWNER_TIMEOUT_MS = 4_000;
    private static final int HISTORY_SIZE = 12;

    enum Mode {
        EXAM(EXAM_LIMIT), GROUP(GROUP_WORK_LIMIT), BREAK(BREAK_LIMIT);

        final int limit;

        Mode(int limit) {
            this.limit = limit;
        }
    }

    // One array cell per recorded second. Rows are kept newest first.
    private final int[][] sessionReadings = new int[HISTORY_SIZE][SESSION_SECONDS];
    private final Summary[] sessionSummaries = new Summary[HISTORY_SIZE];
    private final int[] smoothing = new int[SMOOTHING_READINGS];
    private final int[] recording = new int[SESSION_SECONDS];
    private int historyCount;
    private int nextSessionId = 1;
    private int smoothIndex;
    private int smoothCount;
    private int smoothSum;
    private int level;
    private int adcSpan;
    private int fullScale = 50;
    private final Random demoRandom = new Random();
    private final EnumMap<Mode, Integer> customLimits = new EnumMap<>(Mode.class);
    private Mode mode = Mode.GROUP;
    private String owner;
    private String source = "none";
    private String notice = "";
    private long lastFrame = -1;
    private long attachedAt;
    private long recordingSince = -1;
    private long loudSince = -1;
    private long ignoreAlarmUntil;
    private boolean warningLatched;
    private int alertSequence;
    private int sessionWarnings;
    private int selector = -1;
    private int recordingScale;
    private Instant recordingStarted;

    record Summary(int id, Instant started, Mode mode, String source, int scale, int warnings,
                   double average, int peak, int[] loudest, int limit) { }

    synchronized String apply(String action, String client, String argument, int low,
                              int high, int position, long now) {
        expire(now);
        switch (action) {
            case "attach" -> attach(client, argument, now);
            case "detach" -> {
                if (client.equals(owner)) detach("Input disconnected. Any unfinished session was discarded.");
            }
            case "frame" -> {
                requireOwner(client);
                frame(low, high, position, alarmGuard(argument), now);
            }
            case "mode" -> {
                requireAvailable(client);
                requireIdle();
                if (selector >= 0) throw new IllegalStateException("The hardware switch is selecting the mode.");
                setMode(Mode.valueOf(argument));
            }
            case "threshold" -> {
                requireAvailable(client);
                requireIdle();
                String[] parts = argument.split(":", 2);
                if (parts.length != 2) throw new IllegalArgumentException("Expected a mode and threshold.");
                if (Mode.valueOf(parts[0]) != mode) throw new IllegalStateException("The classroom mode changed. Adjust its threshold again.");
                int limit = Integer.parseInt(parts[1]);
                if (limit < 0 || limit > 100) throw new IllegalArgumentException("Choose a threshold from 0 to 100.");
                if (limit != limitFor(mode)) {
                    customLimits.put(mode, limit);
                    resetWarning();
                }
            }
            case "scale" -> {
                requireAvailable(client);
                requireIdle();
                int scale = Integer.parseInt(argument);
                if (scale < 15 || scale > 150) throw new IllegalArgumentException("Sensitivity is out of range.");
                if (fullScale != scale) {
                    fullScale = scale;
                    resetSignal();
                }
            }
            case "start" -> {
                requireOwner(client);
                requireIdle();
                if (!ready(now)) throw new IllegalStateException("Wait for a live sensor reading first.");
                Arrays.fill(recording, -1);
                recordingSince = now;
                recordingStarted = Instant.now();
                recordingScale = fullScale;
                sessionWarnings = 0;
                resetWarning();
                notice = "";
            }
            case "cancel" -> {
                requireOwner(client);
                abort("Session cancelled.");
            }
            case "test-buzzer" -> {
                requireOwner(client);
                requireIdle();
                if (!source.equals("board") || !ready(now)) {
                    throw new IllegalStateException("Connect the Arduino and wait for live input first.");
                }
                ignoreAlarmUntil = now + alarmGuard(argument);
                resetWarning();
            }
            case "state" -> { }
            default -> throw new IllegalArgumentException("Unknown command.");
        }
        return state(client, now);
    }

    private void attach(String client, String kind, long now) {
        if (!kind.equals("board") && !kind.equals("demo")) throw new IllegalArgumentException("Unknown input.");
        if (owner != null) throw new IllegalStateException("Another tab already has an active input.");
        owner = client;
        source = kind;
        selector = -1;
        attachedAt = now;
        lastFrame = -1;
        notice = "";
        resetSignal();
    }

    private void requireAvailable(String client) {
        if (owner != null) requireOwner(client);
    }

    private void requireOwner(String client) {
        if (!client.equals(owner)) throw new IllegalStateException("This tab does not own the current input.");
    }

    private void requireIdle() {
        if (recordingSince >= 0) throw new IllegalStateException("Settings are locked during a session.");
    }

    private boolean ready(long now) {
        return lastFrame >= 0 && now - lastFrame <= MAX_FRAME_GAP_MS;
    }

    private void expire(long now) {
        if (owner == null) return;
        long reference = lastFrame < 0 ? attachedAt : lastFrame;
        if (now - reference > OWNER_TIMEOUT_MS) {
            detach("Input timed out. Any unfinished session was discarded.");
        } else if (lastFrame >= 0 && !ready(now)) {
            abort("Session discarded because the sensor stopped reporting.");
            resetSignal();
        }
    }

    private void detach(String message) {
        abort(message);
        owner = null;
        source = "none";
        selector = -1;
        lastFrame = -1;
        resetSignal();
        notice = message;
    }

    private void abort(String message) {
        if (recordingSince >= 0) notice = message;
        recordingSince = -1;
    }

    private int limitFor(Mode option) {
        return customLimits.getOrDefault(option, option.limit);
    }

    private void setMode(Mode next) {
        if (next != mode) {
            mode = next;
            resetWarning();
        }
    }

    private void resetWarning() {
        loudSince = -1;
        warningLatched = false;
    }

    private void resetSignal() {
        smoothIndex = 0;
        smoothCount = 0;
        smoothSum = 0;
        level = 0;
        adcSpan = 0;
        ignoreAlarmUntil = 0;
        resetWarning();
    }

    private int alarmGuard(String value) {
        if (value.isEmpty()) return DEFAULT_ALARM_GUARD_MS;
        int duration = Integer.parseInt(value);
        if (duration < DEFAULT_ALARM_GUARD_MS || duration > MAX_ALARM_GUARD_MS) {
            throw new IllegalArgumentException("Invalid alarm duration.");
        }
        return duration;
    }

    private void frame(int low, int high, int position, int alarmGuard, long now) {
        if (low < 0 || high > 1023 || high < low || position < -1 || position > 3) {
            throw new IllegalArgumentException("Invalid sensor frame.");
        }
        lastFrame = now;
        selector = position;
        if (recordingSince >= 0 && now - recordingSince >= SESSION_SECONDS * 1_000L) finish();
        if (recordingSince < 0 && position >= 0 && position < 3) {
            setMode(switch (position) {
                case 1 -> Mode.EXAM;
                case 2 -> Mode.BREAK;
                default -> Mode.GROUP;
            });
        }

        // Avoid feeding the board's own warning sound into its detector.
        if (now >= ignoreAlarmUntil) {
            adcSpan = high - low;
            if (source.equals("demo")) {
                int jitter = demoRandom.nextInt(7) - 3;
                adcSpan = Math.max(0, Math.min(1023, adcSpan + jitter));
            }
            int normalized = Math.max(0, Math.min(100,
                    Math.round((adcSpan - NOISE_FLOOR) * 100f / (fullScale - NOISE_FLOOR))));
            level = movingAverage(normalized);
            updateWarning(now, alarmGuard);
        }
        if (recordingSince >= 0) {
            int second = (int) ((now - recordingSince) / 1_000L);
            recording[second] = Math.max(recording[second], level);
        }
    }

    private int movingAverage(int reading) {
        if (smoothCount < smoothing.length) smoothCount++;
        else smoothSum -= smoothing[smoothIndex];
        smoothing[smoothIndex] = reading;
        smoothSum += reading;
        smoothIndex = (smoothIndex + 1) % smoothing.length;
        return Math.round((float) smoothSum / smoothCount);
    }

    private void updateWarning(long now, int alarmGuard) {
        if (level <= limitFor(mode)) {
            resetWarning();
            return;
        }
        if (loudSince < 0) loudSince = now;
        if (!warningLatched && now - loudSince >= WARNING_MS) {
            warningLatched = true;
            alertSequence++;
            if (recordingSince >= 0) sessionWarnings++;
            if (source.equals("board")) ignoreAlarmUntil = now + alarmGuard;
        }
    }

    private int ledCount() {
        int count = 0;
        for (int threshold : LED_LEVELS) if (level >= threshold) count++;
        return count;
    }

    private void finish() {
        int sum = 0;
        for (int reading : recording) {
            if (reading < 0) {
                abort("Session discarded because a second had no sensor data.");
                return;
            }
            sum += reading;
        }
        int[] top = findLoudest(recording);
        int countToMove = Math.min(historyCount, HISTORY_SIZE - 1);
        for (int row = countToMove; row > 0; row--) {
            System.arraycopy(sessionReadings[row - 1], 0, sessionReadings[row], 0, SESSION_SECONDS);
            sessionSummaries[row] = sessionSummaries[row - 1];
        }
        System.arraycopy(recording, 0, sessionReadings[0], 0, SESSION_SECONDS);
        Summary summary = new Summary(nextSessionId++, recordingStarted, mode, source, recordingScale,
                sessionWarnings, sum / (double) SESSION_SECONDS, recording[top[0]], top, limitFor(mode));
        sessionSummaries[0] = summary;
        historyCount = Math.min(historyCount + 1, HISTORY_SIZE);
        recordingSince = -1;
        notice = "60-second session complete. The report is ready.";
        System.out.printf(java.util.Locale.ROOT, "Session %d | %s | %s | average %.1f | peak %d | warnings %d%n",
                summary.id(), source, mode, summary.average(), summary.peak(), summary.warnings());
        for (int index : top) System.out.printf("  second %d: %d%n", index + 1, recording[index]);
    }

    /** Repeated linear search. Equal levels are ranked by earliest second. */
    static int[] findLoudest(int[] readings) {
        int[] result = new int[3];
        boolean[] selected = new boolean[readings.length];
        for (int rank = 0; rank < result.length; rank++) {
            int best = -1;
            for (int i = 0; i < readings.length; i++) {
                if (!selected[i] && (best < 0 || readings[i] > readings[best])) best = i;
            }
            result[rank] = best;
            selected[best] = true;
        }
        return result;
    }

    private String state(String client, long now) {
        boolean active = recordingSince >= 0;
        int elapsed = active ? (int) ((now - recordingSince) / 1_000L) : 0;
        long loudFor = loudSince < 0 ? 0 : Math.min(WARNING_MS, now - loudSince);
        StringBuilder json = new StringBuilder(1024);
        json.append("{\"source\":\"").append(source).append("\",\"owner\":").append(client.equals(owner))
                .append(",\"ready\":").append(ready(now)).append(",\"mode\":\"").append(mode)
                .append("\",\"limit\":").append(limitFor(mode)).append(",\"scale\":").append(fullScale)
                .append(",\"selector\":").append(selector).append(",\"level\":").append(level)
                .append(",\"adcSpan\":").append(adcSpan).append(",\"leds\":").append(ledCount())
                .append(",\"loudMs\":").append(loudFor).append(",\"alert\":").append(alertSequence)
                .append(",\"warning\":").append(warningLatched).append(",\"active\":").append(active)
                .append(",\"elapsed\":").append(elapsed).append(",\"warnings\":").append(active ? sessionWarnings : 0)
                .append(",\"notice\":\"").append(notice).append("\",\"limits\":{");
        for (Mode option : Mode.values()) {
            if (option != Mode.EXAM) json.append(',');
            json.append('"').append(option).append("\":").append(limitFor(option));
        }
        json.append("},\"history\":[");
        for (int row = 0; row < historyCount; row++) {
            if (row > 0) json.append(',');
            Summary report = sessionSummaries[row];
            json.append("{\"id\":").append(report.id()).append(",\"started\":\"").append(report.started())
                    .append("\",\"mode\":\"").append(report.mode()).append("\",\"source\":\"").append(report.source())
                    .append("\",\"scale\":").append(report.scale())
                    .append(",\"warnings\":").append(report.warnings()).append(",\"limit\":").append(report.limit()).append(",\"average\":").append(report.average())
                    .append(",\"peak\":").append(report.peak()).append(",\"top\":").append(Arrays.toString(report.loudest()))
                    .append(",\"readings\":").append(Arrays.toString(sessionReadings[row])).append('}');
        }
        return json.append("]}").toString();
    }
}
