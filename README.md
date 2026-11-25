# Classroom Noise Meter · 教室噪声计

[简体中文](#简体中文) · [English](#english)

## 简体中文

Arduino Uno 读取声音传感器，Java 计算相对音量并控制五颗 LED。连续超限 5 秒时发出警报。网页支持三档模式、自选报警声、硬件调试和 60 秒会话对比。应用在本机运行，Arduino 通过 USB 连接。

### 安装并启动

1. 在 GitHub 页面点 **Code → Download ZIP**，下载并解压整个项目。文件夹内已有 [可运行的 JAR](./ClassroomNoiseMeter.jar)。如需修改代码，可按下方步骤重新构建。
2. 安装 **Java 17 或更新版本**，并在终端运行 `java -version` 确认。每台演示电脑都需要 Java 以及桌面版 Chrome 或 Edge。 [下载 Temurin JDK 17](https://adoptium.net/temurin/releases/?version=17) · [Chrome 串口支持](https://developer.chrome.com/docs/capabilities/serial) · [Edge 串口支持](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/defaultserialguardsetting)
3. 用 USB 数据线连接已烧录 **StandardFirmata** 的 Arduino Uno。新板或固件被覆盖时，先按下一节烧录。关闭 Arduino IDE 的串口监视器和其他占用串口的程序。
4. Windows 可双击 `start-windows.bat`，macOS 可打开 `start-mac.command`。也可以在解压目录打开终端，运行下面的命令并保持窗口打开。

   ```sh
   java -jar ClassroomNoiseMeter.jar
   ```

5. 用 Chrome 或 Edge 打开 [http://localhost:8765/](http://localhost:8765/)，点 **Connect Arduino**，选择板子的 USB 串口。看到 **Live A0 input** 后即可使用。没有板子时可点 **Try demo**，模拟会话会标注 **Demo**。

### 烧录 StandardFirmata

1. 安装 Arduino IDE，用 USB 数据线连接 Uno。若 IDE 提示缺少板卡包，在 **Boards Manager** 安装 **Arduino AVR Boards**。 [下载 Arduino IDE](https://www.arduino.cc/en/software/) · [板卡包安装说明](https://support.arduino.cc/hc/en-us/articles/360016119519-Add-boards-to-Arduino-IDE)
2. 在 **File → Examples → Firmata → StandardFirmata** 打开示例。如果找不到 **Firmata**，先在 **Library Manager** 搜索并安装 **Firmata**。 [Firmata 项目](https://github.com/firmata/arduino) · [库安装说明](https://support.arduino.cc/hc/en-us/articles/5145457742236-Install-libraries-in-the-Arduino-IDE)
3. 在 **Tools → Board** 选择 **Arduino Uno**，在 **Tools → Port** 选择该板的串口，点击 **Upload** 并等到上传完成。网页按 **57600 baud** 与示例固件通信。 [Arduino 上传说明](https://support.arduino.cc/hc/en-us/articles/4733418441116-Upload-a-sketch-in-Arduino-IDE)

### 接线

| 部件 | Arduino Uno |
| --- | --- |
| 麦克风模块模拟输出 `AO` | `A0` |
| 两颗绿色 LED | `D2`、`D3` |
| 两颗黄色 LED | `D4`、`D5` |
| 一颗红色 LED | `D6` |
| 高电平触发的有源蜂鸣器模块信号 | `D8` |
| 可选三档实体开关的两个外侧触点 | `D9`、`D10` |

每颗 LED 串联一只限流电阻，例如 220–330 Ω，负极接 GND。麦克风和蜂鸣器模块接 Arduino 的公共 GND，电源按模块标注接入。网页可直接切换模式。如使用 **ON–OFF–ON** 三档开关，公共端接 GND，再勾选 **Use physical switch**。D9 接地对应考试档，中间断开对应小组档，D10 接地对应课间档。

### 网页使用说明

- **Classroom mode** 有考试（30）、小组活动（50）和课间（70）三档。数值是 0–100 的相对音量等级，单位为无量纲。可用 **Mic sensitivity** 调整响应。对比会话时可使用相同灵敏度。
- **Alarm sound** 可选 D8 蜂鸣器节奏、电脑提示音或自选音频。平滑音量连续 5 秒严格高于阈值会触发一次警报，降到阈值或以下才重新计时。用 **Test buzzer** 试鸣，或点 **Test sound** 试听并启用电脑声音。自选 MP3、WAV 等文件通过电脑扬声器播放前 3 秒，刷新网页后需重新选择文件。
- **Debug mode** 回读 D2–D6 和 D8 的 `HIGH`／`LOW`，并显示 D8 最近一次 `HIGH` 的时间。A0 每秒显示原始 ADC 的最小值、最大值、峰峰值和样本数。试鸣或报警发生时会标记所属扫描。
- **Start session** 开始 60 秒记录。录制时保持网页在前台，模式和灵敏度会锁定。每秒把最高的平滑等级存为一个读数。取消或掉线会舍弃未完成的一轮。
- **Session reports** 显示平均值、峰值、报警次数和最响的 3 秒。用 **Compare with** 叠加两轮曲线，用 **Print report** 打印或保存 PDF。最近 12 轮保存在当前 Java 进程内，退出后会清空。

串口找不到时，先确认 USB 线支持数据传输、系统识别了板子，并关闭其他串口程序。如果 `8765` 已被占用，运行 `java -jar ClassroomNoiseMeter.jar 8766`，再打开 [http://localhost:8766/](http://localhost:8766/)。

### 从源码构建

安装 **JDK 17 或更新版本**，然后在项目根目录运行以下命令。`src/NoiseMeter.java` 实现移动平均、五秒计时、会话数组和前三名搜索。`src/NoiseServer.java` 提供本机服务，`web/` 包含网页和串口协议处理。

```sh
mkdir build
javac --release 17 --add-modules jdk.httpserver -d build src/NoiseMeter.java src/NoiseServer.java
jar --create --file ClassroomNoiseMeter.jar --main-class NoiseServer -C build . web
java -jar ClassroomNoiseMeter.jar
```

## English

The Arduino Uno samples a sound sensor, and Java calculates a relative sound level that drives five LEDs. The meter sounds an alarm after five consecutive seconds above the selected threshold. The browser also provides three classroom modes, selectable alarm sounds, hardware diagnostics, and 60-second session comparisons. The app runs locally and connects to the Arduino over USB.

### Install and run

1. On GitHub, choose **Code → Download ZIP** and extract the whole project. The folder contains a [ready-to-run JAR](./ClassroomNoiseMeter.jar). Use the build steps below if you want to rebuild it from source.
2. Install **Java 17 or newer** and run `java -version` to check the installation. Each demo computer needs Java and desktop Chrome or Edge. [Download Temurin JDK 17](https://adoptium.net/temurin/releases/?version=17) · [Chrome serial support](https://developer.chrome.com/docs/capabilities/serial) · [Edge serial support](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/defaultserialguardsetting)
3. Connect the Arduino Uno with a USB data cable. The board must be running **StandardFirmata**. Follow the next section if it needs to be flashed. Close the Arduino IDE Serial Monitor and any other program using the serial port.
4. Double-click `start-windows.bat` on Windows or open `start-mac.command` on macOS. You can also run the command below from a terminal in the extracted folder. Keep the terminal open while using the meter.

   ```sh
   java -jar ClassroomNoiseMeter.jar
   ```

5. Open [http://localhost:8765/](http://localhost:8765/) in Chrome or Edge. Click **Connect Arduino** and choose the board’s USB serial port. **Live A0 input** confirms the connection. With no board, click **Try demo**. Reports made with simulated input are marked **Demo**.

### Flash StandardFirmata

1. Install Arduino IDE and connect the Uno with a USB data cable. Use the IDE’s **Boards Manager** to install **Arduino AVR Boards** if prompted. [Download Arduino IDE](https://www.arduino.cc/en/software/) · [Board installation guide](https://support.arduino.cc/hc/en-us/articles/360016119519-Add-boards-to-Arduino-IDE)
2. Open **File → Examples → Firmata → StandardFirmata**. If **Firmata** is missing, install it through the IDE’s **Library Manager**. [Firmata project](https://github.com/firmata/arduino) · [Library installation guide](https://support.arduino.cc/hc/en-us/articles/5145457742236-Install-libraries-in-the-Arduino-IDE)
3. Select **Arduino Uno** under **Tools → Board** and choose the board’s serial port under **Tools → Port**. Click **Upload** and wait for it to finish. The browser communicates with the example firmware at **57600 baud**. [Arduino upload guide](https://support.arduino.cc/hc/en-us/articles/4733418441116-Upload-a-sketch-in-Arduino-IDE)

### Wiring

| Component | Arduino Uno |
| --- | --- |
| Microphone module analog output `AO` | `A0` |
| Two green LEDs | `D2`, `D3` |
| Two yellow LEDs | `D4`, `D5` |
| One red LED | `D6` |
| Active-high buzzer module signal | `D8` |
| Optional three-position switch outside contacts | `D9`, `D10` |

Use one current-limiting resistor per LED, for example 220–330 Ω, and connect each cathode to GND. Connect both modules to the Uno’s common GND and follow their supply voltage markings. Modes are selectable in the browser. With an optional **ON–OFF–ON** switch, connect its common terminal to GND and enable **Use physical switch**. D9 grounded selects Exam, the open center selects Group work, and D10 grounded selects Break.

### Use the dashboard

- **Classroom mode** sets the warning threshold to 30 for Exam, 50 for Group work, or 70 for Break. The displayed level is a unitless 0–100 scale. Adjust **Mic sensitivity** for the room and use the same setting for comparable sessions.
- **Alarm sound** lets you select a D8 buzzer pattern, a built-in computer tone, or a custom file. The alarm fires once after five consecutive seconds strictly above the threshold and rearms at or below it. Use **Test buzzer** to check D8, or **Test sound** to preview and enable speaker audio. Custom audio plays its first three seconds through the computer’s speakers. Re-select the file after refreshing the page.
- **Debug mode** shows the `HIGH` or `LOW` readback for D2–D6 and D8, plus the time of the last confirmed D8 `HIGH`. Every second it shows the A0 minimum, maximum, peak-to-peak span, and sample count in raw ADC units. It marks windows that include an alarm or buzzer test.
- **Start session** begins a 60-second recording. Keep the page in the foreground. The mode and sensitivity are locked for that session, and the highest smoothed level in each second is stored as one reading. Cancelling or losing the input discards an incomplete session.
- **Session reports** shows the average, peak, warning count, and three loudest seconds. Use **Compare with** to overlay two reports. Use **Print report** to print or save a PDF. The 12 most recent sessions stay in memory until the Java process stops.

If the serial port is missing, check the USB data cable, confirm the operating system can see the board, and close other serial programs. If port `8765` is in use, run `java -jar ClassroomNoiseMeter.jar 8766` and open [http://localhost:8766/](http://localhost:8766/).

### Build from source

Install **JDK 17 or newer** and run these commands from the project root. `src/NoiseMeter.java` implements the moving average, five-second timing, session arrays, and top-three search. `src/NoiseServer.java` serves the local app. The `web/` folder contains the dashboard and Firmata serial handling.

```sh
mkdir build
javac --release 17 --add-modules jdk.httpserver -d build src/NoiseMeter.java src/NoiseServer.java
jar --create --file ClassroomNoiseMeter.jar --main-class NoiseServer -C build . web
java -jar ClassroomNoiseMeter.jar
```
