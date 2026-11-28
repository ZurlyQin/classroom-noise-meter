[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Follow Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=flat&logo=telegram&logoColor=white)](https://t.me/JulianGarage)

# Classroom Noise Meter

[简体中文](./README.zh-CN.md) · [English](./README.md)

The Arduino Uno samples a sound sensor, and Java calculates a relative sound level that drives five LEDs. The meter sounds an alarm after five consecutive seconds above the selected threshold. The browser also provides three classroom modes, selectable alarm sounds, hardware diagnostics, and 60-second session comparisons. The app runs locally and connects to the Arduino over USB.

## Install and run

1. On GitHub, choose **Code → Download ZIP** and extract the whole project. The folder contains a [ready-to-run JAR](./ClassroomNoiseMeter.jar). Use the build steps below if you want to rebuild it from source.
2. Install **Java 17 or newer** and run `java -version` to check the installation. Each demo computer needs Java and desktop Chrome or Edge. [Download Temurin JDK 17](https://adoptium.net/temurin/releases/?version=17) · [Chrome serial support](https://developer.chrome.com/docs/capabilities/serial) · [Edge serial support](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/defaultserialguardsetting)
3. Connect the Arduino Uno with a USB data cable. The board must be running **StandardFirmata**. Follow the next section if it needs to be flashed. Close the Arduino IDE Serial Monitor and any other program using the serial port.
4. Double-click `start-windows.bat` on Windows or open `start-mac.command` on macOS. You can also run the command below from a terminal in the extracted folder. Keep the terminal open while using the meter.

   ```sh
   java -jar ClassroomNoiseMeter.jar
   ```

5. Open [http://localhost:8765/](http://localhost:8765/) in Chrome or Edge. Click **Connect Arduino** and choose the board’s USB serial port. **Live A0 input** confirms the connection. Click **Try demo** while connected to drive the five Uno LEDs (D2–D6) with simulated sound levels. **End demo** switches back to the microphone on the same USB connection. With an Arduino buzzer pattern selected, D8 sounds once the simulated level has stayed above the limit for five seconds. You can also try the demo without a board. Reports made with simulated input are marked **Demo**.

## Flash StandardFirmata

1. Install Arduino IDE and connect the Uno with a USB data cable. Use the IDE’s **Boards Manager** to install **Arduino AVR Boards** if prompted. [Download Arduino IDE](https://www.arduino.cc/en/software/) · [Board installation guide](https://support.arduino.cc/hc/en-us/articles/360016119519-Add-boards-to-Arduino-IDE)
2. Open **File → Examples → Firmata → StandardFirmata**. If **Firmata** is missing, install it through the IDE’s **Library Manager**. [Firmata project](https://github.com/firmata/arduino) · [Library installation guide](https://support.arduino.cc/hc/en-us/articles/5145457742236-Install-libraries-in-the-Arduino-IDE)
3. Select **Arduino Uno** under **Tools → Board** and choose the board’s serial port under **Tools → Port**. Click **Upload** and wait for it to finish. The browser communicates with the example firmware at **57600 baud**. [Arduino upload guide](https://support.arduino.cc/hc/en-us/articles/4733418441116-Upload-a-sketch-in-Arduino-IDE)

## Wiring

| Component | Arduino Uno |
| --- | --- |
| Microphone module analog output `AO` | `A0` |
| Two green LEDs | `D2`, `D3` |
| Two yellow LEDs | `D4`, `D5` |
| One red LED | `D6` |
| Active-high buzzer module signal | `D8` |
| Optional three-position switch outside contacts | `D9`, `D10` |

Use one current-limiting resistor per LED, for example 220–330 Ω, and connect each cathode to GND. Connect both modules to the Uno’s common GND and follow their supply voltage markings. Modes are selectable in the browser. With an optional **ON–OFF–ON** switch, connect its common terminal to GND and enable **Use physical switch**. D9 grounded selects Exam, the open center selects Group work, and D10 grounded selects Break.

## Use the dashboard

- **Classroom mode** defaults to a warning threshold of 30 for Exam, 50 for Group work, or 70 for Break. The displayed level is a unitless 0–100 scale. Adjust **Mic sensitivity** for the room and use the same setting for comparable sessions.
- **Alarm sound** lets you select a D8 buzzer pattern, a built-in computer tone, or a custom file. The alarm fires once after five consecutive seconds strictly above the threshold and rearms at or below it. Use **Test buzzer** to check D8, or **Test sound** to preview and enable speaker audio. Custom audio plays its first three seconds through the computer’s speakers. Re-select the file after refreshing the page.
- **Debug mode** shows the `HIGH` or `LOW` readback for D2–D6 and D8, plus the time of the last confirmed D8 `HIGH`. Every second it shows the A0 minimum, maximum, peak-to-peak span, and sample count in raw ADC units. It marks windows that include an alarm or buzzer test.
- In **Debug mode → Alarm threshold**, drag the slider (0–100) and release to set the limit for the selected classroom mode. Changing the limit restarts the five-second timer. Each mode keeps its setting after you close the panel, until the server restarts. The slider is locked during recording.
- **Start session** begins a 60-second recording. Keep the page in the foreground. The mode and sensitivity are locked for that session, and the highest smoothed level in each second is stored as one reading. Cancelling or losing the input discards an incomplete session.
- **Session reports** shows the average, peak, warning count, and three loudest seconds. Use **Compare with** to overlay two reports. Use **Print report** to print or save a PDF. The 12 most recent sessions stay in memory until the Java process stops.

If the serial port is missing, check the USB data cable, confirm the operating system can see the board, and close other serial programs. If port `8765` is in use, run `java -jar ClassroomNoiseMeter.jar 8766` and open [http://localhost:8766/](http://localhost:8766/).

## Build from source

Install **JDK 17 or newer** and run these commands from the project root. `src/NoiseMeter.java` implements the moving average, five-second timing, session arrays, and top-three search. `src/NoiseServer.java` serves the local app. The `web/` folder contains the dashboard and Firmata serial handling.

```sh
mkdir build
javac --release 17 --add-modules jdk.httpserver -d build src/NoiseMeter.java src/NoiseServer.java
jar --create --file ClassroomNoiseMeter.jar --main-class NoiseServer -C build . web
java -jar ClassroomNoiseMeter.jar
```
