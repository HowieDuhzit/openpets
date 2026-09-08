import { getDefaultPetPaused, hideDefaultPet, isDefaultPetVisible, setDefaultPetPaused, showDefaultPet } from "./default-pet-controller.js";
import { openControlCenterWindow } from "./windows.js";
import { type OpenPetsDesktopAction } from "./app-actions-core.js";

export { parseOpenPetsDesktopAction, type OpenPetsDesktopAction } from "./app-actions-core.js";

export function dispatchOpenPetsDesktopAction(action: OpenPetsDesktopAction): void {
  if (action.type === "open-control-center") openControlCenterWindow(action.route);
  else if (action.type === "toggle-default-pet") isDefaultPetVisible() ? hideDefaultPet() : showDefaultPet();
  else setDefaultPetPaused(!getDefaultPetPaused());
  void import("./tray.js").then(({ refreshTrayMenu }) => refreshTrayMenu());
}
