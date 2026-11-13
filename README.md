# PhonePane

Refleja y controla un dispositivo Android desde un panel lateral de VS Code, al estilo del *Running Devices* de IntelliJ.

```
Celular ──adb screencap──▶ Extensión (Node) ──postMessage──▶ Webview (canvas)
        ◀──adb input────── ◀──────────── clics / teclado ────────┘
```

## Requisitos

- `adb` (Android platform-tools). Se detecta solo desde PATH, `ANDROID_HOME`, el SDK de Android Studio o Homebrew; si no, configura `phonePane.adbPath`.
- Depuración USB activada en el dispositivo.

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
| Escribir (con el panel enfocado) | `input text` (solo ASCII) |
| Enter / Retroceso / Supr / Tab / flechas | Teclas equivalentes |
| Esc | Atrás |

La barra inferior tiene Atrás, Inicio, Recientes, volumen y encendido. En el título de la vista están **Pausar** y **Seleccionar dispositivo**. La captura se detiene sola cuando la vista no está visible.

## Ajustes

| Ajuste | Por defecto | Descripción |
| --- | --- | --- |
| `phonePane.adbPath` | `""` | Ruta a `adb`. Vacío = detección automática. |
| `phonePane.frameInterval` | `50` | Milisegundos entre capturas. |

## Limitaciones

- `screencap` en bucle da entre 0,5 y 5 fps según el dispositivo: el PNG se comprime en el teléfono y viaja por USB. Sirve para ver y probar la UI, no para animaciones.
- `input text` no admite caracteres no ASCII (tildes, ñ, emojis).

## Próximos pasos

1. Stream H.264 con `screenrecord --output-format=h264` decodificado con WebCodecs (20–30 fps). Hay que relanzarlo cada 3 minutos.
2. Servidor de scrcpy (vídeo + socket de control) para llegar a 60 fps con teclado y scroll nativos.
