// in-browser-testing-libs.js
var nameInput = document.getElementById("name");
var counterInput = document.getElementById("counter");
var flagInput = document.getElementById("flag");
createButton.addEventListener("click", async () => {
  void await hardware.createDeviceBinding(nameInput.value ?? "");
});
deriveButton.addEventListener("click", async () => {
  const result = await hardware.deriveDeviceEntropy();
  console.log(result);
  resultOutput.textContent = toBase64UrlString(result);
});
