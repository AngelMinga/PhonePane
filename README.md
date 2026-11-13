# PhonePane

Refleja y controla un dispositivo Android desde un panel lateral de VS Code, al estilo del *Running Devices* de IntelliJ.

Tiene dos modos y elige solo el mejor disponible:

| Modo | Cómo funciona | Fluidez |
| --- | --- | --- |
| **scrcpy** (por defecto si está instalado) | Lanza el `scrcpy-server` de tu instalación de scrcpy en el dispositivo, recibe vídeo H.264 que el panel decodifica con WebCodecs y envía los toques por el socket de control de scrcpy | 30–60 fps, toques en tiempo real |
| **Capturas** (respaldo) | `adb exec-out screencap -p` en bucle y `adb shell input` para los toques | 0,5–5 fps |

No hace falta abrir scrcpy en el terminal: la extensión arranca y detiene el servidor ella sola.

## Requisitos

- `adb` (Android platform-tools). Se detecta solo desde PATH, `ANDROID_HOME`, el SDK de Android Studio o Homebrew; si no, configura `phonePane.adbPath`.
- Depuración USB activada en el dispositivo.
- Opcional pero recomendado: [scrcpy](https://github.com/Genymobile/scrcpy) (`brew install scrcpy`). Se usa su `scrcpy-server`, detectado en Homebrew, `/usr/share/scrcpy` o `SCRCPY_SERVER_PATH`.

## Uso

1. `npm install`
2. Abre esta carpeta en VS Code y pulsa **F5**.
3. En la ventana nueva, abre el icono del teléfono en la barra de actividad. Puedes arrastrar la vista a la barra lateral secundaria.

| Acción en el panel | En el dispositivo |
| --- | --- |
| Clic | Toque |
| Arrastrar | Swipe |
| Mantener pulsado (≥ 450 ms) | Pulsación larga |
| Rueda del ratón | Scroll |
| Escribir (con el panel enfocado) | Texto (en modo capturas, solo ASCII) |
| Enter / Retroceso / Supr / Tab / flechas | Teclas equivalentes |
| Esc | Atrás |

La barra inferior tiene Atrás, Inicio, Recientes, volumen y encendido. En el título de la vista están **Pausar** y **Seleccionar dispositivo**. La captura se detiene sola cuando la vista no está visible.

## Ajustes

| Ajuste | Por defecto | Descripción |
| --- | --- | --- |
| `phonePane.adbPath` | `""` | Ruta a `adb`. Vacío = detección automática. |
| `phonePane.mode` | `auto` | `auto`, `scrcpy` o `screencap`. |
| `phonePane.scrcpyServerPath` | `""` | Ruta a `scrcpy-server`. Vacío = detección automática. |
| `phonePane.maxSize` | `1280` | scrcpy: lado máximo del vídeo en píxeles (`0` = nativo). |
| `phonePane.videoBitRate` | `8000000` | scrcpy: bits por segundo. |
| `phonePane.frameInterval` | `50` | Modo capturas: milisegundos entre capturas. |

## Instalar localmente

```sh
npm install
npx @vscode/vsce package
code --install-extension phonepane-*.vsix --force
```

Después, **Developer: Reload Window** en VS Code. Los mensajes del servidor aparecen en **PhonePane: Mostrar registro**.

## Limitaciones

- El modo capturas da entre 0,5 y 5 fps según el dispositivo: el PNG se comprime en el teléfono y viaja por USB.
- En modo capturas, `input text` no admite caracteres no ASCII (tildes, ñ, emojis).
- La versión del `scrcpy-server` debe coincidir con la que anuncia el cliente; se toma de la ruta de Homebrew o de `scrcpy --version`.
