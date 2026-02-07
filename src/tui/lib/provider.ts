export namespace Provider {
  export function parseModel(str: string): { providerID: string; modelID: string } {
    const parts = str.split("/")
    if (parts.length >= 2) {
      return {
        providerID: parts[0],
        modelID: parts.slice(1).join("/"),
      }
    }
    // If no slash, treat entire string as modelID with empty providerID
    return {
      providerID: "",
      modelID: str,
    }
  }
}
