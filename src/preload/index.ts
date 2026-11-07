import { contextBridge, ipcRenderer } from 'electron'
import { eventChannel, INVOKE_METHODS, invokeChannel, type OatmealApi } from '@shared/api'

const api = Object.fromEntries(
  INVOKE_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke(invokeChannel(method), ...args)]),
) as unknown as Omit<OatmealApi, 'on'>

const on: OatmealApi['on'] = (event, listener) => {
  const handler = (_: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never)
  ipcRenderer.on(eventChannel(event), handler)
  return () => ipcRenderer.off(eventChannel(event), handler)
}

contextBridge.exposeInMainWorld('oatmeal', { ...api, on } satisfies OatmealApi)
