/**
 * macOS activation of the pet window. Electron's `panel` window is an NSWindow that only reports the
 * non-activating panel style, so a click on the pet still activates the application, and the next click on another
 * application's window is spent bringing that window forward. AppKit's window activation flag keeps the person's
 * frontmost application in place.
 */
import type { BrowserWindow } from 'electron'

/**
 * Keep clicks on the window from activating the application. Text fields in the window still take input, including
 * input-method composition.
 * @param window - the pet window, before it is shown.
 */
export async function preventPetWindowActivation(window: BrowserWindow): Promise<void> {
  const koffi = (await import('koffi')).default
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  const selector = objc.func('void *sel_registerName(const char *)')
  const sendPointer = objc.func('objc_msgSend', 'void *', ['void *', 'void *'])
  const sendSelector = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *'])
  const sendBool = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'bool'])
  const nsWindow: unknown = sendPointer(koffi.decode(window.getNativeWindowHandle(), 'void *'), selector('window'))
  const prevents: unknown = selector('_setPreventsActivation:')
  if (nsWindow === null || !(sendSelector(nsWindow, selector('respondsToSelector:'), prevents) as boolean)) {
    throw new Error('desktop pet: this macOS version cannot keep the pet window from activating the application')
  }
  sendBool(nsWindow, prevents, true)
}
