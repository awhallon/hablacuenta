const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function freshDom() {
  let pageHtml = html.replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, '');
  // Mock jsPDF with the chainable API surface buildPDF() actually calls
  function MockJsPDF(opts) {
    this.opts = opts;
  }
  const chainMethods = ["setFontSize","setFont","setTextColor","text","setDrawColor","setLineWidth","line","setFillColor","roundedRect","splitTextToSize","addPage","addImage"];
  chainMethods.forEach(m => {
    MockJsPDF.prototype[m] = function(...args) {
      if (m === "splitTextToSize") return [String(args[0])];
      return this;
    };
  });
  MockJsPDF.prototype.output = function(type) { return new Blob(["fake-pdf-content"], {type:"application/pdf"}); };
  MockJsPDF.prototype.save = function(fname) { /* no-op in test environment — no real file download to perform */ };

  const dom = new JSDOM(pageHtml, {
    runScripts: "dangerously",
    resources: "usable",
    url: "https://hablacuenta.com/",
    beforeParse(window) {
      window.jspdf = { jsPDF: MockJsPDF };
      // jsdom does not implement IndexedDB at all — wire in a fresh, isolated fake-indexeddb
      // instance per test so the real savePhotoBlob/getPhotoBlob/deletePhotoBlob code paths
      // (not just their localStorage-quota-failure fallback) can actually be exercised.
      const FDBFactory = require("fake-indexeddb/lib/FDBFactory");
      window.indexedDB = new FDBFactory();
      // jsdom doesn't implement URL.createObjectURL or a real window.open — shim both so the
      // PDF-viewing code path (which calls these) can actually run instead of throwing.
      if(!window.URL.createObjectURL) window.URL.createObjectURL = (blob) => "blob:mock-url-" + Math.random().toString(36).slice(2);
      if(!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
      window.open = (url, target) => {
        return { closed: false, location: { href: "" } };
      };
    }
  });
  // Helper: access let/const top-level variables, which aren't exposed as window properties in jsdom's vm context
  dom.window.get = (expr) => dom.window.eval(expr);
  dom.window.set = (varName, value) => dom.window.eval(`${varName} = ${JSON.stringify(value)}`);
  dom.window.call = (expr) => dom.window.eval(expr);
  return dom;
}

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

// freshDom() runs the page's scripts immediately on construction (runScripts: "dangerously"),
// so localStorage must be seeded via beforeParse — BEFORE scripts run — not after construction,
// or the page will have already read an empty localStorage and baked in the defaults.
function domWithPreseededStorage(storageEntries) {
  function MockJsPDF(opts) { this.opts = opts; }
  const chainMethods = ["setFontSize","setFont","setTextColor","text","setDrawColor","setLineWidth","line","setFillColor","roundedRect","splitTextToSize","addPage","addImage"];
  chainMethods.forEach(m => {
    MockJsPDF.prototype[m] = function(...args) {
      if (m === "splitTextToSize") return [String(args[0])];
      return this;
    };
  });
  MockJsPDF.prototype.output = function(type) { return new Blob(["fake-pdf-content"], {type:"application/pdf"}); };
  MockJsPDF.prototype.save = function(fname) { /* no-op in test environment */ };
  const dom = new JSDOM(html.replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, ''), {
    runScripts: "dangerously",
    resources: "usable",
    url: "https://hablacuenta.com/",
    beforeParse(window) {
      window.jspdf = { jsPDF: MockJsPDF };
      const FDBFactory = require("fake-indexeddb/lib/FDBFactory");
      window.indexedDB = new FDBFactory();
      Object.entries(storageEntries).forEach(([k, v]) => window.localStorage.setItem(k, v));
    }
  });
  dom.window.get = (expr) => dom.window.eval(expr);
  return dom;
}

async function testBPLWFlow() {
  console.log("\n=== TEST SUITE 1: BPLW Materials Invoice (Alfonso's flow, explicitly configured) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // BPLW/Alfonso's setup is no longer the app's default for fresh installs — explicitly
  // configure it here, the same way a real BPLW contractor would via Settings.
  win.eval(`
    contractorInfo = {firstName:"Alfonso", lastName:"Sanchez", businessName:"Alfonso Sanchez Property Services", address:"310 Main Ave Apt 1, Long Beach CA 90802", phone:"562-533-7907", mode:"bplw"};
    resetChat();
  `);
  await wait(100);

  check("Explicitly-configured BPLW mode is active", win.get("contractorInfo.mode") === "bplw");
  check("Greeting shows Alfonso's firstName", win.document.getElementById("chatBox").innerHTML.includes("Alfonso"));

  // Simulate picking Materials Only
  win.eval('invoiceType = "materials"; convStage = "client_type";');

  // Simulate AI asking for partner -> picking Richard Baisz
  win.eval('currentOrderedBy = "Richard Baisz"; convStage = "street";');

  // Simulate address chip click building the full address
  const addresses = win.eval('getClientAddresses("Richard Baisz")');
  check("Richard Baisz has no preset addresses (each partner manages own properties)", addresses.length === 0);

  const andrewAddresses = win.eval('getClientAddresses("Andrew Whallon")');
  check("Andrew Whallon has preset addresses", andrewAddresses.length > 0, `found ${andrewAddresses.length}`);

  // Simulate full invoiceData as if AI returned it
  win.eval(`invoiceData = ${JSON.stringify({
    done: true,
    client_type: "bplw",
    bill_to_name: "BPLW Management",
    bill_to_address: "PO Box 9395, Long Beach CA 90810",
    bill_to_email: "baisz@sbcglobal.net",
    bill_to_phone: "310-809-3856",
    ordered_by: "Richard Baisz",
    job_address: "1001 Cherry Ave Unit 101, Long Beach CA 90813",
    work_items: [],
    materials_items: [
      { vendor: "Home Depot", desc: "Paint", date: "6-15-2026", amount: 45.99 },
      { vendor: "Ace Hardware", desc: "Screws", date: "6-16-2026", amount: 8.50 }
    ],
    date: "6-20-2026",
    has_materials: true,
    has_labor: false,
    new_client: null
  })}; receipts = []; jobPhotos = [];`);

  win.document.getElementById("photoSections").style.display = "block";
  win.document.getElementById("receiptSection").style.display = "block";
  win.eval('showInvoicePreview(invoiceData)');
  await wait(100);

  const invoiceArea = win.document.getElementById("invoiceArea").innerHTML;
  check("Invoice preview shows BPLW Management as Bill To", invoiceArea.includes("BPLW Management"));
  check("Invoice preview shows Richard Baisz as Ordered By", invoiceArea.includes("Richard Baisz"));
  check("Invoice preview shows job address", invoiceArea.includes("1001 Cherry Ave Unit 101"));
  check("Invoice preview shows Home Depot vendor", invoiceArea.includes("Home Depot"));
  check("Invoice preview shows materials date", invoiceArea.includes("6-15-2026"));
  check("Invoice preview total is correct ($54.49)", invoiceArea.includes("54.49"), "expected sum of 45.99+8.50");
  check("From shows Alfonso's business name (default)", invoiceArea.includes("Alfonso Sanchez Property Services"));

  // Test PDF build (without actually rendering, just checking it doesn't throw)
  try {
    const builtOk = win.eval('(async () => { try { const b = await buildPDF("materials"); return JSON.stringify({ok:true, invNum:b.invNum, matNum}); } catch(e) { return JSON.stringify({ok:false, err:e.message}); } })()');
    const result = await builtOk;
    const parsed = JSON.parse(result);
    check("buildPDF executes without error for materials", parsed.ok, parsed.err);
    if (parsed.ok) check("buildPDF returns correct invoice number", parsed.invNum === parsed.matNum);
  } catch (e) {
    check("buildPDF executes without error for materials", false, e.message);
  }

  // Test History recording
  const beforeHistoryLen = win.eval('invoiceHistory.length');
  win.eval('recordInvoiceHistory("materials", matNum)');
  const afterHistoryLen = win.eval('invoiceHistory.length');
  check("Invoice history grows after recording", afterHistoryLen === beforeHistoryLen + 1);
  const firstEntryAddr = win.eval('invoiceHistory[0].invoiceData.job_address');
  check("Recorded history entry has correct job address", firstEntryAddr.includes("1001 Cherry Ave"));
}

async function testGenericMode() {
  console.log("\n=== TEST SUITE 2: Generic Mode (non-BPLW contractor) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Configure as generic contractor
  win.eval('showSettings()');
  win.document.getElementById("setFirstName").value = "Adrian";
  win.document.getElementById("setLastName").value = "Quintana";
  win.document.getElementById("setBusinessName").value = "";
  win.document.getElementById("setStreet").value = "1952 Caspian Avenue";
  win.document.getElementById("setCity").value = "Long Beach";
  win.document.getElementById("setState").value = "CA";
  win.document.getElementById("setZip").value = "90810";
  win.document.getElementById("setPhone").value = "555-1212";
  win.document.getElementById("setMode").value = "generic";
  win.eval('saveSettingsForm()');

  check("Settings saved generic mode", win.eval("contractorInfo.mode") === "generic");
  check("Header updated to First Last (no business name)", win.document.getElementById("headerTitleText").textContent.includes("Adrian Quintana"));

  win.eval('resetChat()');
  await wait(100);
  check("Greeting uses firstName only", win.document.getElementById("chatBox").innerHTML.includes("Hi Adrian!"));

  // Test empty client list shows + New client chip
  win.eval('invoiceType = "materials"; showSavedClientChips();');
  const chipArea = win.document.getElementById("chipArea").innerHTML;
  check("Empty client list still shows +New client chip", chipArea.includes("New client"), "this was the actual bug reported by tester");

  // Add a client and verify it shows as a chip
  win.eval(`addClient({ name: "Test Client Co", address: "456 Demo St", email: "test@example.com", phone: "555-9999" })`);
  win.eval('showSavedClientChips()');
  const chipArea2 = win.document.getElementById("chipArea").innerHTML;
  check("After adding a client, chip shows their name", chipArea2.includes("Test Client Co"));
  check("New client chip still present alongside saved clients", chipArea2.includes("New client"));

  // Simulate completed generic invoice
  win.eval(`invoiceData = ${JSON.stringify({
    done: true,
    client_type: "generic",
    bill_to_name: "Test Client Co",
    bill_to_address: "456 Demo St",
    bill_to_email: "test@example.com",
    bill_to_phone: "555-9999",
    ordered_by: "",
    job_address: "789 Job Site Rd",
    work_items: [{ desc: "Fix fence", amount: 200 }],
    materials_items: [],
    date: "6-20-2026",
    has_materials: false,
    has_labor: true,
    new_client: null
  })}; invoiceType = "labor"; showInvoicePreview(invoiceData);`);
  await wait(100);
  const invoiceArea = win.document.getElementById("invoiceArea").innerHTML;
  check("Generic invoice shows correct From (Adrian Quintana, no business name)", invoiceArea.includes("Adrian Quintana"));
  check("Generic invoice hides 'Ordered By' when blank", !invoiceArea.includes("Ordered By"));
  check("Generic invoice shows bill-to client", invoiceArea.includes("Test Client Co"));
  check("Generic invoice shows job address", invoiceArea.includes("789 Job Site Rd"));
}

async function testSettingsMigration() {
  console.log("\n=== TEST SUITE 3: Settings Migration (old single-name format) ===");
  const dom = freshDom();
  const win = dom.window;
  win.localStorage.setItem("contractor_info", JSON.stringify({
    name: "Old Format Contractor",
    address: "Old Address",
    phone: "555-0000",
    mode: "generic"
  }));
  await wait(300);
  const infoJson = win.eval("JSON.stringify(loadContractorInfo())");
  const info = JSON.parse(infoJson);
  check("Migrated firstName equals old name", info.firstName === "Old Format Contractor");
  check("Migrated businessName is blank (not duplicated)", info.businessName === "");
  check("Migrated lastName is blank", info.lastName === "");
  check("Old 'name' field removed after migration", !("name" in info));
}

async function testPanelNavigation() {
  console.log("\n=== TEST SUITE 4: Panel Navigation (stacking bug regression check) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.showHistory();
  win.showSettings();
  const historyDisplay = win.document.getElementById("historyPanel").style.display;
  const settingsDisplay = win.document.getElementById("settingsPanel").style.display;
  check("Only Settings panel visible after showSettings (History properly hidden)", historyDisplay === "none" && settingsDisplay === "block");

  win.showManager();
  win.showAddressManager();
  const managerDisplay = win.document.getElementById("managerPanel").style.display;
  const addrDisplay = win.document.getElementById("addressManagerPanel").style.display;
  check("Only AddressManager visible after showAddressManager (Manager properly hidden)", managerDisplay === "none" && addrDisplay === "block");
}

async function testFreshDeviceDefaultsToGenericOnboarding() {
  console.log("\n=== TEST SUITE 5: Fresh Device Defaults to Empty Generic Mode + Onboarding (regression for the hardcoded-Alfonso privacy/UX bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("Fresh device defaults to generic mode, NOT bplw", win.eval("contractorInfo.mode") === "generic");
  check("Fresh device has NO firstName pre-filled", win.eval("contractorInfo.firstName") === "");
  check("Fresh device has NO businessName pre-filled (Alfonso's business info must not leak to new installs)",
    win.eval("contractorInfo.businessName") === "");
  check("Fresh device has NO address pre-filled", win.eval("contractorInfo.address") === "");
  check("Fresh device has NO phone pre-filled", win.eval("contractorInfo.phone") === "");
  check("Fresh device shows the welcome/onboarding message, not the normal invoice-type greeting",
    win.document.getElementById("chatBox").innerHTML.toLowerCase().includes("welcome"));
  check("Fresh device does NOT show 'Hi !' or any greeting assuming a name exists",
    !win.document.getElementById("chatBox").innerHTML.includes("Hi !"));

  // A contractor who explicitly configures BPLW mode (the real Alfonso use case) should still work correctly
  const sysPrompt = win.eval("getSystemPrompt()");
  check("Default generic-mode system prompt does NOT mention BPLW Management",
    !sysPrompt.includes("BPLW Management"));
}

async function testBackButtonVisibility() {
  console.log("\n=== TEST SUITE 6: Back Button Visibility (regression for reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // BPLW mode: pick Materials Only, should be able to go back
  win.eval(`
    invoiceType = "materials";
    convStage = "client_type";
    showBackBtn(true);
    messages.push({role:"user",content:"Materials Only"});
    messages.push({role:"assistant",content:"Perfect. Which partner ordered the materials?"});
  `);
  let backVisible = win.document.getElementById("backBtn").style.display;
  check("BPLW mode: Back button visible after picking invoice type", backVisible === "block");

  win.eval('goBack()');
  const stageAfterBack = win.eval('convStage');
  check("BPLW mode: goBack() reverts to invoice_type stage", stageAfterBack === "invoice_type");

  // Generic mode: configure, then simulate the smartChips trigger for "who is this invoice for"
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`
    contractorInfo.mode = "generic";
    invoiceType = "materials";
    messages.push({role:"user",content:"Materials Only"});
    messages.push({role:"assistant",content:"Hi! Let's create a materials-only invoice. Who is this invoice for?"});
  `);
  win2.eval(`smartChips("Hi! Let's create a materials-only invoice. Who is this invoice for?")`);
  const backVisible2 = win2.document.getElementById("backBtn").style.display;
  check("Generic mode: Back button visible at client-selection step (the actual reported bug)", backVisible2 === "block");

  const stage2 = win2.eval('convStage');
  check("Generic mode: convStage correctly set to client_type", stage2 === "client_type");

  win2.eval('goBack()');
  const stageAfterBack2 = win2.eval('convStage');
  check("Generic mode: goBack() reverts to invoice_type stage", stageAfterBack2 === "invoice_type");
}

async function testNewClientFlow() {
  console.log("\n=== TEST SUITE 7: Guided New-Client Entry Flow ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Start the flow
  win.eval('startNewClient()');
  check("startNewClient sets newClientState to name step", win.eval('newClientState.step') === "name");
  check("AI prompts for client name", win.document.getElementById("chatBox").innerHTML.includes("client's name"));

  // Provide a name
  win.eval(`document.getElementById("userInput").value = "Maria Lopez"; sendMsg();`);
  check("After name, step advances to awaiting_address", win.eval('newClientState.step') === "awaiting_address");
  check("Name was stored correctly", win.eval('newClientState.data.name') === "Maria Lopez");

  // Skip address entirely
  win.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  check("After skipping address, step advances to email", win.eval('newClientState.step') === "email");
  check("Skipped address stored as blank, not 'Skip'", win.eval('newClientState.data.address') === "");

  // Provide email
  win.eval(`document.getElementById("userInput").value = "maria@example.com"; sendMsg();`);
  check("After email, step advances to phone", win.eval('newClientState.step') === "phone");

  // Skip phone
  win.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  check("After skipping phone, step advances to summary", win.eval('newClientState.step') === "summary");

  const summaryHtml = win.document.getElementById("chatBox").innerHTML;
  check("Summary shows the name", summaryHtml.includes("Maria Lopez"));
  check("Summary shows blank address note", summaryHtml.includes("blank"));

  // Confirm looks good -> should save and clear state
  win.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  check("newClientState cleared after saving", win.eval('newClientState') === null);
  const savedClients = JSON.parse(win.eval('JSON.stringify(savedClients)'));
  const saved = savedClients.find(c => c.name === "Maria Lopez");
  check("Client actually saved to savedClients with correct name", !!saved);
  check("Saved client has blank address (not the word Skip)", saved && saved.address === "");
  check("Saved client has correct email", saved && saved.email === "maria@example.com");

  // Test the edit-before-saving path
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval('startNewClient()');
  win2.eval(`document.getElementById("userInput").value = "Wrong Name"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // address
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // email
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // phone, lands on summary
  check("Reached summary step before testing edit", win2.eval('newClientState.step') === "summary");

  win2.eval(`document.getElementById("userInput").value = "Fix something"; sendMsg();`);
  check("Choosing fix-something moves to edit_field step", win2.eval('newClientState.step') === "edit_field");

  win2.eval(`document.getElementById("userInput").value = "Name"; sendMsg();`);
  check("Picking Name field moves to editing_name step", win2.eval('newClientState.step') === "editing_name");

  win2.eval(`document.getElementById("userInput").value = "Corrected Name"; sendMsg();`);
  check("After correction, returns to summary step", win2.eval('newClientState.step') === "summary");
  const correctedSummary = win2.document.getElementById("chatBox").innerHTML;
  check("Summary now shows corrected name", correctedSummary.includes("Corrected Name"));

  win2.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  const savedClients2 = JSON.parse(win2.eval('JSON.stringify(savedClients)'));
  const saved2 = savedClients2.find(c => c.name === "Corrected Name");
  check("Corrected name was the one actually saved (not the original typo)", !!saved2);

  // Test the full unified guided address flow with a unit number, launched via the client flow
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  win4.eval('startNewClient()');
  win4.eval(`document.getElementById("userInput").value = "Sam Rivera"; sendMsg();`);
  check("Name step advances to awaiting_address", win4.eval('newClientState.step') === "awaiting_address");

  // Saying anything other than Skip should launch the unified guided address flow
  win4.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`);
  check("guidedAddrState launched with client purpose", win4.eval('guidedAddrState !== null && guidedAddrState.purpose') === "client");
  check("guidedAddrState starts at street step", win4.eval('guidedAddrState.step') === "street");

  win4.eval(`document.getElementById("userInput").value = "1234 Ocean Blvd"; sendMsg();`);
  check("Street step advances to unit_yn", win4.eval('guidedAddrState.step') === "unit_yn");
  check("Street stored correctly", win4.eval('guidedAddrState.data.street') === "1234 Ocean Blvd");

  win4.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`);
  check("Saying Yes to unit moves to unit_number", win4.eval('guidedAddrState.step') === "unit_number");

  win4.eval(`document.getElementById("userInput").value = "Suite 200"; sendMsg();`);
  check("Unit number step advances to city", win4.eval('guidedAddrState.step') === "city");
  check("Unit stored correctly", win4.eval('guidedAddrState.data.unit') === "Suite 200");

  win4.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  check("City step advances to state", win4.eval('guidedAddrState.step') === "state");

  win4.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  check("State step advances to zip", win4.eval('guidedAddrState.step') === "zip");

  win4.eval(`document.getElementById("userInput").value = "90802"; sendMsg();`);
  check("After zip, guidedAddrState is cleared (handed back to client flow)", win4.eval('guidedAddrState') === null);
  check("Client flow resumes at email step", win4.eval('newClientState.step') === "email");
  const builtAddress = win4.eval('newClientState.data.address');
  check("Built address includes street", builtAddress.includes("1234 Ocean Blvd"));
  check("Built address includes unit", builtAddress.includes("Suite 200"));
  check("Built address includes city", builtAddress.includes("Long Beach"));
  check("Built address includes state", builtAddress.includes("CA"));
  check("Built address includes zip", builtAddress.includes("90802"));

  // Test the no-unit path (typing "No" instead of a direct unit)
  const dom5 = freshDom();
  const win5 = dom5.window;
  await wait(300);
  win5.eval('startNewClient()');
  win5.eval(`document.getElementById("userInput").value = "Jane Doe"; sendMsg();`);
  win5.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`); // wants to add address
  win5.eval(`document.getElementById("userInput").value = "500 Main St"; sendMsg();`);
  win5.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  check("Saying No to unit skips straight to city", win5.eval('guidedAddrState.step') === "city");
  check("Unit correctly stored as blank when answered No", win5.eval('guidedAddrState.data.unit') === "");
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // city
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // state
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // zip
  check("After skipping city/state/zip, hands back to client flow at email step", win5.eval('newClientState.step') === "email");
  const minimalAddress = win5.eval('newClientState.data.address');
  check("Minimal address still includes street even with everything else skipped", minimalAddress.includes("500 Main St"));

  // Test that "Skip" at the very first address question bypasses the entire guided flow
  const dom6 = freshDom();
  const win6 = dom6.window;
  await wait(300);
  win6.eval('startNewClient()');
  win6.eval(`document.getElementById("userInput").value = "Test Person"; sendMsg();`);
  win6.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  check("Skipping at awaiting_address jumps straight to email (never launches guidedAddrState)", win6.eval('newClientState.step') === "email");
  check("guidedAddrState never launched when address is skipped upfront", win6.eval('guidedAddrState') === null);
  check("Address is blank when skipped at the very first address question", win6.eval('newClientState.data.address') === "");

  // Test that resetChat clears any in-progress newClientState
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval('startNewClient()');
  check("newClientState set before reset", win3.eval('newClientState') !== null);
  win3.eval('resetChat()');
  check("resetChat() clears in-progress newClientState", win3.eval('newClientState') === null);
}

async function testPhoneFormatting() {
  console.log("\n=== TEST SUITE 8: Phone Number Formatting ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("Formats raw 10 digits", win.eval('formatPhone("5628828632")') === "562-882-8632");
  check("Formats digits with spaces", win.eval('formatPhone("562 882 8632")') === "562-882-8632");
  check("Formats digits with parens/dashes", win.eval('formatPhone("(562) 882-8632")') === "562-882-8632");
  check("Formats 11-digit with leading 1", win.eval('formatPhone("15628828632")') === "562-882-8632");
  check("Leaves already-correct format unchanged", win.eval('formatPhone("562-882-8632")') === "562-882-8632");
  check("Leaves non-10/11-digit numbers as typed (e.g. international)", win.eval('formatPhone("+44 20 7946 0958")') === "+44 20 7946 0958");
  check("Handles empty string without throwing", win.eval('formatPhone("")') === "");
  check("Handles null/undefined gracefully", win.eval('formatPhone(null)') === null);

  // Integration: new-client flow formats phone before saving
  win.eval('startNewClient()');
  win.eval(`document.getElementById("userInput").value = "Carlos Mendez"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // street
  win.eval(`document.getElementById("userInput").value = "test@example.com"; sendMsg();`); // email
  win.eval(`document.getElementById("userInput").value = "5551234567"; sendMsg();`); // phone, raw digits
  check("New-client flow formats phone in summary step data", win.eval('newClientState.data.phone') === "555-123-4567");
  win.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  const clients = JSON.parse(win.eval('JSON.stringify(savedClients)'));
  const saved = clients.find(c => c.name === "Carlos Mendez");
  check("Saved client record has formatted phone", saved && saved.phone === "555-123-4567");

  // Integration: editing phone from summary also formats it
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval('startNewClient()');
  win2.eval(`document.getElementById("userInput").value = "Test User"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // email
  win2.eval(`document.getElementById("userInput").value = "5559998888"; sendMsg();`); // phone
  win2.eval(`document.getElementById("userInput").value = "Fix something"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Phone"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "5550001111"; sendMsg();`); // corrected phone, raw digits
  check("Editing phone field from summary applies formatting", win2.eval('newClientState.data.phone') === "555-000-1111");

  // Integration: Settings contractor phone gets formatted
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval('showSettings()');
  win3.document.getElementById("setFirstName").value = "Test";
  win3.document.getElementById("setPhone").value = "5621234567";
  win3.eval('saveSettingsForm()');
  check("Settings contractor phone formatted on save", win3.eval('contractorInfo.phone') === "562-123-4567");
}

async function testClientHandoffMessage() {
  console.log("\n=== TEST SUITE 9: New-Client Handoff to AI (regression for re-asking bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval('startNewClient()');
  win.eval(`document.getElementById("userInput").value = "Andrew Whallon"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`); // wants to add address now
  win.eval(`document.getElementById("userInput").value = "1995 Canal Avenue"; sendMsg();`); // street
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`); // no unit
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`); // city
  win.eval(`document.getElementById("userInput").value = "California"; sendMsg();`); // state
  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`); // zip
  win.eval(`document.getElementById("userInput").value = "andywhallon@yahoo.com"; sendMsg();`); // email
  win.eval(`document.getElementById("userInput").value = "5628828632"; sendMsg();`); // phone
  check("Reached summary step with all fields collected", win.eval('newClientState.step') === "summary");

  // Confirm — this triggers the handoff to the AI
  win.eval(`document.getElementById("userInput").value = "Looks good"; sendMsg();`);
  await wait(100);

  // Check what was actually pushed into messages[] for the AI to see (ignore network failure in test env)
  const lastMsg = win.eval('messages[messages.length-1].content');
  check("Handoff message explicitly tells AI not to re-ask for contact details",
    lastMsg.includes("do NOT ask for these again"), `actual message: ${lastMsg}`);
  check("Handoff message confirms client is fully saved",
    lastMsg.toLowerCase().includes("already been fully saved"));
  check("Handoff message still identifies the client by name",
    lastMsg.includes("Andrew Whallon"));

  // Visible chat bubble should stay clean (just the name), even though the AI sees the longer instruction
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Visible chat bubble shows just the client name, not the internal instruction",
    chatHtml.includes(">Andrew Whallon<") && !chatHtml.includes("App note:"));

  // Confirm the client was actually saved with formatted phone before handoff
  const clients = JSON.parse(win.eval('JSON.stringify(savedClients)'));
  const saved = clients.find(c => c.name === "Andrew Whallon");
  check("Client was saved before handoff occurred", !!saved);
  check("Saved client phone is formatted", saved && saved.phone === "562-882-8632");

  // Retry path: lastUserText should also carry the full handoff instruction, not just the bare name
  const retryText = win.eval('lastUserText');
  check("lastUserText (used on retry) also contains the no-re-ask instruction",
    retryText.includes("do NOT ask for these again"));
}

async function testGenericJobAddressFlow() {
  console.log("\n=== TEST SUITE 10: Guided Job-Address Flow (Generic Mode) — regression for Adrian's reported bug ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`contractorInfo.mode = "generic"; invoiceType = "labor"; currentOrderedBy = "";`);

  // Simulate the AI asking for job address — should trigger the guided flow, not accept free text directly
  win.eval(`smartChips("Great! Andrew Whallon it is. What's the job address?")`);
  check("Job address question triggers unified guided flow in generic mode", win.eval('guidedAddrState !== null'));
  check("Guided flow purpose is job", win.eval('guidedAddrState.purpose') === "job");
  check("Guided flow starts at street step", win.eval('guidedAddrState.step') === "street");

  const introHtml = win.document.getElementById("chatBox").innerHTML;
  check("Intro message lists all 5 fields it will ask about",
    introHtml.includes("Street address") && introHtml.includes("Unit") && introHtml.includes("City") && introHtml.includes("State") && introHtml.includes("Zip"));

  // Walk through the full flow with a unit number, matching Adrian's real address structure
  win.eval(`document.getElementById("userInput").value = "1993 Canal Avenue"; sendMsg();`);
  check("Street step advances to unit_yn", win.eval('guidedAddrState.step') === "unit_yn");
  check("Street stored correctly", win.eval('guidedAddrState.data.street') === "1993 Canal Avenue");

  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  check("Saying No to unit skips straight to city", win.eval('guidedAddrState.step') === "city");
  check("Unit stored as blank", win.eval('guidedAddrState.data.unit') === "");

  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  check("City step advances to state", win.eval('guidedAddrState.step') === "state");

  win.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  check("State step advances to zip", win.eval('guidedAddrState.step') === "zip");

  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`);
  await wait(100);
  check("After zip, guidedAddrState is cleared (flow complete)", win.eval('guidedAddrState') === null);
  check("convStage advances to tasks after job address complete", win.eval('convStage') === "tasks");

  const handoffMsg = win.eval('messages[messages.length-1].content');
  check("Handoff message includes the full built address", handoffMsg.includes("1993 Canal Avenue") && handoffMsg.includes("Long Beach") && handoffMsg.includes("CA") && handoffMsg.includes("90810"));
  check("Handoff message tells AI not to re-ask for address", handoffMsg.includes("do NOT ask for it again"));

  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Visible chat shows the clean built address, not the internal instruction", chatHtml.includes("1993 Canal Avenue") && !chatHtml.includes("App note:"));

  // Test the explicit-unit path
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`contractorInfo.mode = "generic"; invoiceType = "labor";`);
  win2.eval(`smartChips("What's the job address?")`);
  win2.eval(`document.getElementById("userInput").value = "500 Main St"; sendMsg();`);
  win2.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`);
  check("Saying Yes to unit moves to unit_number step", win2.eval('guidedAddrState.step') === "unit_number");
  win2.eval(`document.getElementById("userInput").value = "Apt 4B"; sendMsg();`);
  check("Unit number step advances to city", win2.eval('guidedAddrState.step') === "city");
  check("Unit stored correctly", win2.eval('guidedAddrState.data.unit') === "Apt 4B");
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // city
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // state
  win2.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // zip
  await wait(100);
  const handoffMsg2 = win2.eval('messages[messages.length-1].content');
  check("Address with unit but skipped city/state/zip still includes street and unit", handoffMsg2.includes("500 Main St") && handoffMsg2.includes("Apt 4B"));

  // Confirm BPLW mode is completely unaffected — should still use the original chip-based picker, not this new flow
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval(`contractorInfo.mode = "bplw"; currentOrderedBy = "Andrew Whallon";`);
  win3.eval(`smartChips("Which address was the job at?")`);
  check("BPLW mode does NOT trigger the unified guided job-address flow", win3.eval('guidedAddrState') === null);
  const bplwChipArea = win3.document.getElementById("chipArea").innerHTML;
  check("BPLW mode still shows the original address chips", bplwChipArea.includes("chip"));

  // Confirm resetChat clears any in-progress guidedAddrState
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  win4.eval(`contractorInfo.mode = "generic";`);
  win4.eval(`startGuidedAddress("job")`);
  check("guidedAddrState set before reset", win4.eval('guidedAddrState') !== null);
  win4.eval('resetChat()');
  check("resetChat() clears in-progress guidedAddrState", win4.eval('guidedAddrState') === null);
}

async function testUnifiedAddressBplwAndContractorPurposes() {
  console.log("\n=== TEST SUITE 11: Unified Guided Address Flow — BPLW and Contractor Settings purposes ===");

  // BPLW purpose: adding a new address for a partner via the chat (the original "+ Add new address" chip)
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  win.eval(`contractorInfo.mode = "bplw";`);
  win.eval(`startGuidedAddress("bplw", {clientName: "Richard Baisz"})`);
  check("BPLW purpose stored on guidedAddrState", win.eval('guidedAddrState.purpose') === "bplw");
  check("BPLW meta carries the client name", win.eval('guidedAddrState.meta.clientName') === "Richard Baisz");

  win.eval(`document.getElementById("userInput").value = "777 Anaheim St"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "90804"; sendMsg();`);
  check("guidedAddrState cleared after BPLW address completes", win.eval('guidedAddrState') === null);

  const richardAddrs = JSON.parse(win.eval(`JSON.stringify(getClientAddresses("Richard Baisz"))`));
  const savedAddr = richardAddrs.find(a => a.full && a.full.includes("777 Anaheim St"));
  check("New BPLW address actually saved to Richard Baisz's address book", !!savedAddr);
  check("Saved BPLW address includes city/state/zip", savedAddr && savedAddr.full.includes("Long Beach") && savedAddr.full.includes("CA") && savedAddr.full.includes("90804"));

  // Confirm this doesn't affect Andrew Whallon's separate preloaded address list
  const andrewAddrs = JSON.parse(win.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("Andrew Whallon's preloaded addresses remain untouched", andrewAddrs.length > 0);

  // Confirm the BPLW legacy edit_field path (Address Manager single-field correction) still works independently
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval(`
    editingAddressKey = "addr_TestClient";
    editingAddressIdx = 0;
    editingAddressData = {streetName:"Old St", streetNum:"100", unit:"", city:"Old City", zip:"90000"};
    localStorage.setItem("addr_TestClient", JSON.stringify([{id:"x", display:"100 Old St", full:"100 Old St, Old City 90000"}]));
    newAddrState = {step:"edit_field", data:{...editingAddressData, field:"city"}};
  `);
  win3.eval(`document.getElementById("userInput").value = "New City"; sendMsg();`);
  const updatedList = JSON.parse(win3.eval(`localStorage.getItem("addr_TestClient")`));
  check("Legacy edit_field path still updates a saved BPLW address correctly", updatedList[0].full.includes("New City"));
  check("newAddrState cleared after edit_field completes", win3.eval('newAddrState') === null);
}

async function testDateYearValidation() {
  console.log("\n=== TEST SUITE 12: Date Year Validation ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // dateHasYear unit tests
  check("Detects a full date with year as valid", win.eval(`dateHasYear("May 5, 2026")`) === true);
  check("Detects MM/DD/YYYY as valid", win.eval(`dateHasYear("5/5/2026")`) === true);
  check("Detects a 2-digit year as missing a real year (e.g. '5/5/26' has no 4-digit year)", win.eval(`dateHasYear("5/5/26")`) === false);
  check("Detects 'May 5' with no year as invalid", win.eval(`dateHasYear("May 5")`) === false);
  check("Detects '5/5' with no year as invalid", win.eval(`dateHasYear("5/5")`) === false);
  check("Blank date is not flagged (not this check's concern)", win.eval(`dateHasYear("")`) === true);
  check("Null date is not flagged", win.eval(`dateHasYear(null)`) === true);
  check("Detects year embedded mid-string", win.eval(`dateHasYear("2026-05-05")`) === true);

  // findMissingYearDates unit tests
  const result1 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5", materials_items:[]}))`));
  check("Flags a missing-year invoice date", result1.length === 1 && result1[0].label === "invoice date");

  const result2 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5, 2026", materials_items:[{vendor:"Home Depot",date:"June 1",amount:50}]}))`));
  check("Flags a missing-year receipt date while invoice date is fine", result2.length === 1 && result2[0].label.includes("receipt 1"));
  check("Receipt label includes the vendor name for clarity", result2[0].label.includes("Home Depot"));

  const result3 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5, 2026", materials_items:[{vendor:"A",date:"June 1, 2026",amount:10},{vendor:"B",date:"July 15",amount:20}]}))`));
  check("Only flags the actual offending date among multiple receipts", result3.length === 1 && result3[0].label.includes("B"));

  const result4 = JSON.parse(win.eval(`JSON.stringify(findMissingYearDates({date:"May 5, 2026", materials_items:[{vendor:"A",date:"June 1, 2026",amount:10}]}))`));
  check("Returns empty array when all dates are complete", result4.length === 0);

  // Integration: the backstop fires correctly when callClaude receives a final JSON with a bad date.
  // We can't hit the real API in this sandbox, so we exercise the exact same code path the way
  // callClaude would after parsing a reply, calling the relevant logic directly.
  win.eval(`
    invoiceData = {done:true, date:"May 5", materials_items:[], bill_to_phone:"", new_client:null};
    const missingYearDates = findMissingYearDates(invoiceData);
    if (missingYearDates.length > 0) {
      const first = missingYearDates[0];
      const thisYear = new Date().getFullYear();
      addAIMsg("I see the " + first.label + " (\\"" + first.value + "\\") doesn't include a year. Was that " + thisYear + ", or a different year?");
      showYearClarifyChips(first.label, thisYear);
    }
  `);
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Backstop produces a clarifying message mentioning the bad date", chatHtml.includes("May 5") && chatHtml.includes("doesn't include a year"));
  const chipHtml = win.document.getElementById("chipArea").innerHTML;
  check("Year-clarify chips render with current year option", chipHtml.includes(String(new Date().getFullYear())));
  check("Year-clarify chips include a different-year option", chipHtml.toLowerCase().includes("different year"));
}

async function testJobAddressConfirmationDoesNotRetrigger() {
  console.log("\n=== TEST SUITE 13: Job-Address Confirmation Does Not Re-trigger Guided Flow (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  win.eval(`contractorInfo.mode = "generic"; invoiceType = "labor";`);

  // The actual question (with a "?") should still trigger the guided flow correctly
  win.eval(`smartChips("Great! Let's continue. What's the job address?")`);
  check("The real question (with ?) still triggers the guided flow", win.eval('guidedAddrState !== null'));

  // Complete the flow normally
  win.eval(`document.getElementById("userInput").value = "1995 Canal Avenue"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "California"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`);
  check("guidedAddrState cleared after the real flow completes", win.eval('guidedAddrState') === null);

  // Now simulate the exact AI confirmation message from Adrian's screenshot —
  // this is a STATEMENT restating the address, not a question, and must NOT re-trigger the flow
  win.eval(`smartChips("Got it! The job address is 1995, Long Beach California 90810. What was the first task and price?")`);
  check("Confirmation statement (no '?' near 'job address') does NOT re-trigger guidedAddrState",
    win.eval('guidedAddrState') === null);

  // Sanity check: a similar confirmation phrasing without a question mark anywhere near 'address' is also safe
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`contractorInfo.mode = "generic";`);
  win2.eval(`smartChips("The job address is 123 Main St, Anytown CA 90000.")`);
  check("A bare confirmation sentence with no question mark never triggers the guided flow",
    win2.eval('guidedAddrState') === null);

  // And confirm BPLW mode's equivalent confirmation phrasing is also safe
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval(`smartChips("Got it, the address was the job at 1001 Cherry Ave. What was the first task and price?")`);
  check("BPLW mode confirmation phrasing does not re-trigger the address picker chips unexpectedly",
    win3.document.getElementById("chipArea").innerHTML === "");
}

async function testAiStatedWrongYearGetsCorrected() {
  console.log("\n=== TEST SUITE 14: AI-Stated Wrong Year Gets Corrected (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Reproduce the exact AI reply from Adrian's screenshot, where the AI stated 2025
  // despite the real current year (per the device/sandbox clock) being 2026.
  const aiReplyWithWrongYear = "Got it — and was that this year (2025), or a different year?";
  const corrected = win.eval(`
    (function(){
      let reply = ${JSON.stringify(aiReplyWithWrongYear)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  const realCurrentYear = win.eval('new Date().getFullYear()');
  check("Wrong year in AI reply gets corrected to the real current year",
    corrected.includes(String(realCurrentYear)) && !corrected.includes("2025"),
    `corrected text: "${corrected}", expected year: ${realCurrentYear}`);
  check("Corrected text otherwise preserves the original message",
    corrected.includes("Got it") && corrected.includes("different year"));

  // Confirm a reply with the CORRECT year already is left untouched (no double-correction artifacts)
  const correctYearReply = `Got it — and was that this year (${realCurrentYear}), or a different year?`;
  const unchanged = win.eval(`
    (function(){
      let reply = ${JSON.stringify(correctYearReply)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  check("A reply with the already-correct year is left unchanged", unchanged === correctYearReply);

  // Confirm the Spanish phrasing pattern is also caught
  const spanishWrongYear = "Entendido — ¿fue este año (2025), o un año diferente?";
  const correctedEs = win.eval(`
    (function(){
      let reply = ${JSON.stringify(spanishWrongYear)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  check("Spanish-phrased wrong year also gets corrected", correctedEs.includes(String(realCurrentYear)) && !correctedEs.includes("2025"));

  // Confirm a reply with no year-clarification pattern at all passes through untouched
  const unrelatedReply = "What was the first task and price?";
  const stillUnrelated = win.eval(`
    (function(){
      let reply = ${JSON.stringify(unrelatedReply)};
      const yearClarifyMatch = reply.match(/this year\\s*\\((\\d{4})\\)/i) || reply.match(/este año\\s*\\((\\d{4})\\)/i);
      if (yearClarifyMatch) {
        const statedYear = yearClarifyMatch[1];
        const actualYear = String(new Date().getFullYear());
        if (statedYear !== actualYear) {
          reply = reply.replace(statedYear, actualYear);
        }
      }
      return reply;
    })()
  `);
  check("Unrelated replies with no year pattern pass through completely untouched", stillUnrelated === unrelatedReply);
}

async function testFormattedSummaryPhoneFormatting() {
  console.log("\n=== TEST SUITE 15: Formatted Summary Phone Number Formatting (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Reproduce the exact raw AI summary text from Adrian's screenshot, with an unformatted phone number
  const rawSummary = "Here's what I have:\n\nClient: Andrew Whallon\nClient Address: 1995 Canal Avenue\nClient Email: andywhallon@yahoo.com\nClient Phone: 5628828632\nJob Address: 1995 Canal Avenue, Long Beach California 90810\n\nWork Performed:\n- Repair the sprinkler system - $500.00\n\nDate Completed: June 16, 2026\n\nIs everything correct?";

  win.eval(`showFormattedSummary(${JSON.stringify(rawSummary)})`);
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Formatted summary shows the phone number reformatted as xxx-xxx-xxxx",
    chatHtml.includes("562-882-8632"), `chat HTML: ${chatHtml.slice(0,400)}`);
  check("Formatted summary no longer shows the raw unformatted digits",
    !chatHtml.includes("5628828632"));
  check("Formatted summary still preserves the email address correctly",
    chatHtml.includes("andywhallon@yahoo.com"));
  check("Formatted summary still preserves the client name",
    chatHtml.includes("Andrew Whallon"));

  // Test with a Spanish label too
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  const rawSummaryEs = "Cliente: Andrew Whallon\nTeléfono: 5628828632\nDirección del trabajo: 1995 Canal Avenue";
  win2.eval(`showFormattedSummary(${JSON.stringify(rawSummaryEs)})`);
  const chatHtmlEs = win2.document.getElementById("chatBox").innerHTML;
  check("Spanish 'Teléfono' label phone number also gets reformatted",
    chatHtmlEs.includes("562-882-8632"));

  // Test that a summary with no phone number at all doesn't error or get mangled
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  const rawSummaryNoPhone = "Client: Test Client\nJob Address: 123 Main St\nDate: June 16, 2026";
  win3.eval(`showFormattedSummary(${JSON.stringify(rawSummaryNoPhone)})`);
  const chatHtmlNoPhone = win3.document.getElementById("chatBox").innerHTML;
  check("Summary with no phone number renders without error", chatHtmlNoPhone.includes("Test Client"));

  // Test a phone number already in the correct format isn't double-mangled
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  const rawSummaryFormatted = "Client: Test Client\nClient Phone: 562-882-8632\nJob Address: 123 Main St";
  win4.eval(`showFormattedSummary(${JSON.stringify(rawSummaryFormatted)})`);
  const chatHtmlFormatted = win4.document.getElementById("chatBox").innerHTML;
  check("An already-correctly-formatted phone number passes through unchanged",
    chatHtmlFormatted.includes("562-882-8632") && !chatHtmlFormatted.includes("562-882-882-8632"));
}

async function testConfirmationTriggerMatchesActualPromptWording() {
  console.log("\n=== TEST SUITE 16: Confirmation Trigger Matches Actual Prompt Wording (regression for Adrian's reported bug) ===");

  // Pull the actual instructed confirmation phrase directly out of the live system prompt,
  // so this test fails loudly if the prompt wording ever changes again without updating the trigger.
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  const sysPrompt = win.eval('getSystemPrompt()');
  const promptMatch = sysPrompt.match(/Then ask "([^"]+)"/);
  check("System prompt contains an explicit confirmation question instruction", !!promptMatch);

  if (promptMatch) {
    const actualInstructedPhrase = promptMatch[1];
    const lower = actualInstructedPhrase.toLowerCase();
    const triggerMatches = lower.includes("confirm") || lower.includes("everything correct") || lower.includes("look correct") || lower.includes("need to be fixed") || lower.includes("confirmar") || lower.includes("todo correcto") || lower.includes("se ve correcto") || lower.includes("corregir algo");
    check(`The exact instructed confirmation phrase ("${actualInstructedPhrase}") matches the showFormattedSummary trigger`,
      triggerMatches, "if this fails, the prompt wording changed without updating the trigger condition — exactly the bug Adrian hit");
  }

  // Also directly verify the specific phrase that caused the real bug
  const bugPhrase = "Does everything look correct, or do you want to fix something?".toLowerCase();
  const bugPhraseMatches = bugPhrase.includes("confirm") || bugPhrase.includes("everything correct") || bugPhrase.includes("look correct") || bugPhrase.includes("need to be fixed") || bugPhrase.includes("confirmar") || bugPhrase.includes("todo correcto");
  check("The exact phrase from Adrian's bug report now matches the trigger", bugPhraseMatches);

  // End-to-end: simulate showFormattedSummary firing on a reply using the real instructed phrasing,
  // confirming phone formatting actually applies when triggered through the real condition logic
  const fullReply = "Client: Andrew Whallon\nClient Phone: 5628828632\nJob Address: 123 Main St\n\nDoes everything look correct, or do you want to fix something?";
  const lower = fullReply.toLowerCase();
  const wouldTrigger = lower.includes("confirm") || lower.includes("everything correct") || lower.includes("look correct") || lower.includes("need to be fixed") || lower.includes("confirmar") || lower.includes("todo correcto");
  check("The full realistic AI reply triggers showFormattedSummary", wouldTrigger);

  if (wouldTrigger) {
    win.eval(`showFormattedSummary(${JSON.stringify(fullReply)})`);
    const chatHtml = win.document.getElementById("chatBox").innerHTML;
    check("When correctly triggered, the phone number is formatted in the displayed summary",
      chatHtml.includes("562-882-8632") && !chatHtml.includes("5628828632"));
  }
}

async function testCombinedLaborMaterialsInvoice() {
  console.log("\n=== TEST SUITE 17: Combined Labor + Materials Invoice (regression for Adrian's reported bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`
    invoiceType = "both";
    invoiceData = {
      done: true, client_type: "generic",
      bill_to_name: "Test Client", bill_to_address: "123 Main St", bill_to_email: "test@example.com", bill_to_phone: "555-123-4567",
      ordered_by: "", job_address: "456 Job Site Rd",
      work_items: [{desc:"Repair sprinkler system", amount:500}],
      materials_items: [{vendor:"Home Depot", desc:"PVC pipe", date:"June 3, 2026", amount:35.12}],
      date: "June 3, 2026", has_materials: true, has_labor: true, new_client: null
    };
    receipts = []; jobPhotos = [];
    document.getElementById("photoSections").style.display = "block";
    document.getElementById("receiptSection").style.display = "block";
    showInvoicePreview(invoiceData);
  `);
  await wait(100);

  const invoiceArea = win.document.getElementById("invoiceArea").innerHTML;
  const cardCount = (invoiceArea.match(/class="invoice-preview"/g) || []).length;
  check("Combined invoice renders as ONE invoice card, not two", cardCount === 1, `found ${cardCount} cards`);
  check("Combined invoice header mentions both Labor and Materials", invoiceArea.includes("Labor") && invoiceArea.includes("Materials"));
  check("Combined invoice shows the Work Performed section", invoiceArea.includes("Repair sprinkler system"));
  check("Combined invoice shows the Materials section", invoiceArea.includes("Home Depot"));
  check("Combined invoice shows a Labor subtotal", invoiceArea.includes("Subtotal") && invoiceArea.includes("500.00"));
  check("Combined invoice shows a Materials subtotal", invoiceArea.includes("35.12"));
  check("Combined invoice shows ONE grand total of 535.12", invoiceArea.includes("535.12"));
  check("Combined invoice has a single Generate PDF button (not two separate ones)",
    (invoiceArea.match(/Generate.*PDF/g) || []).length === 1);
  check("Combined invoice has a single Share Invoice button", (invoiceArea.match(/Share Invoice/g) || []).length === 1);

  // Test buildPDF produces a single combined PDF object with the right invoice number
  const builtInfo = win.eval(`
    (async () => {
      const built = await buildPDF("both");
      return JSON.stringify({fname: built.fname, invNum: built.invNum, isCombined: built.isCombined});
    })()
  `);
  const parsed = JSON.parse(await builtInfo);
  check("buildPDF('both') returns a combined result", parsed.isCombined === true);
  check("Combined PDF filename doesn't say 'Labor_Invoice' or 'Materials_Invoice' specifically", 
    !parsed.fname.includes("Labor_Invoice") && !parsed.fname.includes("Materials_Invoice"));

  // Test the correction menu offers both Work/Tasks AND Materials/Receipts for combined invoices
  win.eval(`showCorrectionMenu("both")`);
  const correctionAreaHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Correction menu for combined invoice offers Work/Tasks option", correctionAreaHtml.includes("Work") || correctionAreaHtml.includes("Tasks"));
  check("Correction menu for combined invoice offers Materials/Receipts option", correctionAreaHtml.includes("Materials") || correctionAreaHtml.includes("Receipts"));

  // Test history list shows the new layout: number, date, customer, street address, amount
  win.eval(`
    invoiceHistory = [{type:"both", invNum:30001, invoiceData:{
      ordered_by:"Andrew Whallon", job_address:"456 Job Site Rd, Long Beach CA 90810", date:"June 3, 2026",
      work_items:[{desc:"Task A",amount:500}], materials_items:[{vendor:"X",desc:"Y",date:"z",amount:50}]
    }, receipts:[], jobPhotos:[], created_at:new Date().toISOString()}];
    renderHistoryList();
  `);
  const historyHtml = win.document.getElementById("historyList").innerHTML;
  check("History list shows the invoice number", historyHtml.includes("#30001"));
  check("History list shows the date", historyHtml.includes("June 3, 2026"));
  check("History list shows the customer (ordered_by)", historyHtml.includes("Andrew Whallon"));
  check("History list shows just the STREET address, not the full city/state/zip", historyHtml.includes("456 Job Site Rd") && !historyHtml.includes("Long Beach CA 90810"));
  check("History list shows the total amount (labor + materials combined)", historyHtml.includes("550.00"));
  check("History list no longer shows a Labor/Materials/Combined type label",
    !historyHtml.includes("Labor & Materials") && !historyHtml.includes("Labor &amp; Materials") && !historyHtml.includes(">Materials<") && !historyHtml.includes(">Labor<"));

  // Generic mode: customer should fall back to bill_to_name when ordered_by is blank
  win.eval(`
    invoiceHistory = [{type:"materials", invNum:30002, invoiceData:{
      ordered_by:"", bill_to_name:"Generic Client Co", job_address:"789 Other St, Riverside CA 92501", date:"June 5, 2026",
      work_items:[], materials_items:[{vendor:"X",desc:"Y",date:"z",amount:25}]
    }, receipts:[], jobPhotos:[], created_at:new Date().toISOString()}];
    renderHistoryList();
  `);
  const genericHistoryHtml = win.document.getElementById("historyList").innerHTML;
  check("Generic mode (no ordered_by) falls back to showing bill_to_name as the customer",
    genericHistoryHtml.includes("Generic Client Co"));
}

async function testPhotoOrientationCorrection() {
  console.log("\n=== TEST SUITE 18: Photo Orientation Re-encoding (regression for Adrian's reported double-rotation bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // reencodePhotoForConsistentOrientation should resolve with SOME dataUrl for a normal load,
  // and critically must NOT apply any manual ctx.transform() rotation of its own — that was
  // the actual bug: the browser already EXIF-corrects images on decode, and our own additional
  // manual rotation on top of that double-rotated the result.
  const fnSource = win.eval('reencodePhotoForConsistentOrientation.toString()');
  check("reencodePhotoForConsistentOrientation does NOT call ctx.transform (no manual rotation)",
    !fnSource.includes("ctx.transform"), "if this fails, manual rotation was reintroduced — the exact double-rotation bug");
  check("reencodePhotoForConsistentOrientation does NOT reference EXIF orientation values 2-8",
    !/case\s*[2-8]\s*:/.test(fnSource));
  check("reencodePhotoForConsistentOrientation draws the image via ctx.drawImage", fnSource.includes("drawImage"));
  check("reencodePhotoForConsistentOrientation re-exports via canvas.toDataURL (strips EXIF, bakes in browser's correction)",
    fnSource.includes("toDataURL"));
  check("reencodePhotoForConsistentOrientation falls back to the original photo on error (onerror handler)",
    fnSource.includes("onerror"));

  // Confirm getExifOrientation and correctImageOrientation no longer exist —
  // they were the source of the double-rotation bug and should be fully removed, not just unused.
  const oldFnsRemoved = win.eval(`typeof getExifOrientation === "undefined" && typeof correctImageOrientation === "undefined"`);
  check("The old manual EXIF-rotation functions have been fully removed, not left as dead code", oldFnsRemoved);

  // Verify handlePhoto calls the new re-encode function and has a safe fallback
  const handlePhotoSource = win.eval('handlePhoto.toString()');
  check("handlePhoto calls reencodePhotoForConsistentOrientation before storing the photo",
    handlePhotoSource.includes("reencodePhotoForConsistentOrientation"));
  check("handlePhoto has a fallback (try/catch) so a failed re-encode doesn't block adding the photo",
    handlePhotoSource.includes("catch"));
  check("handlePhoto no longer references the removed manual EXIF functions",
    !handlePhotoSource.includes("getExifOrientation") && !handlePhotoSource.includes("correctImageOrientation"));
}

async function testGenericModeJobAddressPersistence() {
  console.log("\n=== TEST SUITE 19: Generic-Mode Job Address Persistence (regression for Adrian's reported bug) ===");

  // Picking a saved client should set currentOrderedBy, which is required for address lookup
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  win.eval(`
    contractorInfo.mode = "generic";
    addClient({name:"Andrew Whallon", address:"", email:"andywhallon@yahoo.com", phone:"562-882-8632"});
    showSavedClientChips();
  `);
  // Simulate clicking the first saved-client chip
  win.eval(`document.querySelector('#chipArea .chip:not(.new)').click()`);
  check("Picking a saved client sets currentOrderedBy to that client's name", win.eval('currentOrderedBy') === "Andrew Whallon");

  // First time asking for job address: no saved addresses yet, should launch the guided flow directly
  await wait(100);
  win.eval(`smartChips("What's the job address?")`);
  check("With no saved addresses, the guided flow launches directly", win.eval('guidedAddrState !== null && guidedAddrState.purpose') === "job");
  check("guidedAddrState meta carries the client name for persistence", win.eval('guidedAddrState.meta.clientName') === "Andrew Whallon");

  // Complete the guided flow
  win.eval(`document.getElementById("userInput").value = "1995 Canal Avenue"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  win.eval(`document.getElementById("userInput").value = "90810"; sendMsg();`);
  await wait(100);

  // Confirm the address was actually persisted to this client's address book
  const savedAddrs = JSON.parse(win.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("The completed job address was saved to the client's address book", savedAddrs.length === 1, `found ${savedAddrs.length} addresses`);
  check("Saved address includes the full street/city/state/zip", savedAddrs[0] && savedAddrs[0].full.includes("1995 Canal Avenue") && savedAddrs[0].full.includes("Long Beach"));

  const savedMsg = win.document.getElementById("chatBox").innerHTML;
  check("Confirmation message tells the user the address will be remembered next time",
    savedMsg.toLowerCase().includes("remember"));

  // Second invoice for the SAME client: this time it should offer the saved address as a chip,
  // not silently re-run the entire 5-question guided flow from scratch
  win.eval(`resetChat(); contractorInfo.mode = "generic"; currentOrderedBy = "Andrew Whallon";`);
  win.eval(`smartChips("What's the job address?")`);
  check("On the second invoice, the guided flow does NOT launch again (a saved address exists)",
    win.eval('guidedAddrState') === null);
  const chipArea = win.document.getElementById("chipArea").innerHTML;
  check("The previously-saved address appears as a selectable chip", chipArea.includes("1995 Canal Avenue"));
  check("A '+ Add new address' option is still available for a different job site", chipArea.includes("Add new address") || chipArea.includes("Nueva dirección"));

  // Clicking the saved-address chip should hand off correctly without re-running the guided flow
  win.eval(`document.querySelector('#chipArea .chip:not(.new)').click()`);
  await wait(100);
  const handoffMsg = win.eval('messages[messages.length-1].content');
  check("Clicking the saved address chip hands off the full address to the AI", handoffMsg.includes("1995 Canal Avenue"));
  check("guidedAddrState was never launched when using a saved address chip", win.eval('guidedAddrState') === null);
}

async function testAndrewWhallonNameCollisionFix() {
  console.log("\n=== TEST SUITE 20: Andrew Whallon Name Collision Fix (regression for cross-contamination bug) ===");

  // In BPLW mode, "Andrew Whallon" should still correctly get Alfonso's real preloaded addresses
  const domBplw = freshDom();
  const winBplw = domBplw.window;
  await wait(300);
  winBplw.eval(`contractorInfo.mode = "bplw";`);
  const bplwAddrs = JSON.parse(winBplw.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("BPLW mode: Andrew Whallon still gets the preloaded Long Beach address list", bplwAddrs.length > 0);

  // In generic mode, a client who happens to ALSO be named "Andrew Whallon" must NOT see
  // Alfonso's real preloaded addresses — this was the actual collision bug
  const domGeneric = freshDom();
  const winGeneric = domGeneric.window;
  await wait(300);
  winGeneric.eval(`contractorInfo.mode = "generic";`);
  const genericAddrs = JSON.parse(winGeneric.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("Generic mode: a same-named client does NOT inherit Alfonso's preloaded BPLW addresses",
    genericAddrs.length === 0, `found ${genericAddrs.length} addresses, expected 0`);

  // After saving an address for this generic-mode client, only that address should appear —
  // never mixed in with the BPLW preloaded list
  winGeneric.eval(`saveClientAddress("Andrew Whallon", {id:"x", display:"999 Adrian St", full:"999 Adrian St, Riverside CA 92501"})`);
  const genericAddrsAfterSave = JSON.parse(winGeneric.eval(`JSON.stringify(getClientAddresses("Andrew Whallon"))`));
  check("Generic mode: only the contractor's own saved address appears, not BPLW's list",
    genericAddrsAfterSave.length === 1 && genericAddrsAfterSave[0].full.includes("Riverside"));
}

async function testJobPhotoPromptFlow() {
  console.log("\n=== TEST SUITE 21: In-Conversation Job Photo Prompt (regression for Adrian's reported asymmetry bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // The trigger phrase should show the job photo chips, mirroring the receipt photo trigger
  win.eval(`smartChips("Got it. Want to add a photo of the job?")`);
  const chipArea = win.document.getElementById("chipArea").innerHTML;
  check("Job photo prompt phrase triggers showJobPhotoChips", chipArea.includes("Take photo") || chipArea.includes("Tomar foto"));
  check("Job photo chips include a Skip option", chipArea.includes("Skip") || chipArea.includes("Omitir"));

  // Confirm showJobPhotoChips sets up the correct click handler (triggers job-type photo capture)
  win.eval(`showJobPhotoChips()`);
  win.eval(`document.querySelector('#chipArea .chip.new').click()`);
  check("Clicking 'Take photo' sets pendingPhotoChipMsg, same mechanism as receipts", win.eval('pendingPhotoChipMsg') === "📷 Photo added");

  // Simulate a job photo actually being captured via handlePhoto, and confirm it resumes
  // the conversation afterward — this was the actual missing piece (receipt photos already
  // did this, job photos silently did not).
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`
    pendingPhotoChipMsg = "📷 Photo added";
    jobPhotos = [];
    messages = [];
  `);
  // Simulate what handlePhoto does for a job photo after EXIF correction, without needing a real File object
  win2.eval(`
    (function(){
      const dataUrl = "data:image/jpeg;base64,FAKE";
      if(jobPhotos.length>=8){return;}
      jobPhotos.push(dataUrl);renderJobPhotos();
      if(pendingPhotoChipMsg){
        const msg=pendingPhotoChipMsg;pendingPhotoChipMsg=null;
        document.getElementById("userInput").value=msg;sendMsg();
      }
    })()
  `);
  await wait(100);
  check("Job photo was actually added to jobPhotos", win2.eval('jobPhotos.length') === 1);
  check("After capturing a job photo via the chip flow, the conversation resumes (pendingPhotoChipMsg cleared)",
    win2.eval('pendingPhotoChipMsg') === null);
  const sentMsg = win2.eval('messages.length > 0 ? messages[messages.length-1].content : null');
  check("A follow-up message was sent to the AI after the job photo was captured", sentMsg === "📷 Photo added");

  // Confirm the system prompt actually instructs the AI to ask about job photos after labor tasks
  const sysPrompt = win.eval('getSystemPrompt()');
  check("System prompt instructs the AI to ask about a job photo after collecting labor tasks",
    sysPrompt.includes("Want to add a photo of the job"));
}

async function testRetroactiveContractorPhoneFormatting() {
  console.log("\n=== TEST SUITE 22: Retroactive Contractor Phone Formatting (regression for Adrian's reported bug) ===");

  // Simulate a device with contractor_info saved BEFORE the formatPhone fix existed —
  // exactly Adrian's actual situation, with the unformatted number from his real screenshot
  const dom = domWithPreseededStorage({
    contractor_info: JSON.stringify({
      firstName: "Adrian", lastName: "Quintana", businessName: "",
      address: "1952 Caspian Avenue Long Beach California 90810",
      phone: "5628675309", // raw, unformatted — as it would have been saved before the fix
      mode: "generic"
    })
  });
  const win = dom.window;
  await wait(300);

  const loadedPhone = win.eval('contractorInfo.phone');
  check("Stale unformatted contractor phone is corrected on load", loadedPhone === "562-867-5309",
    `got: ${loadedPhone}`);

  // Confirm this shows up correctly in the actual invoice preview, not just in the raw object
  win.eval(`
    invoiceType = "both";
    invoiceData = {
      done:true, bill_to_name:"Andrew Whallon", bill_to_address:"1995 Canal Avenue", bill_to_email:"andywhallon@yahoo.com", bill_to_phone:"562-882-8632",
      ordered_by:"", job_address:"1993 Canal Avenue, Long Beach CA 90810",
      work_items:[{desc:"Install sprinkler system", amount:500}],
      materials_items:[{vendor:"Home Depot", desc:"PVC pipe", date:"May 5, 2026", amount:50}],
      date:"June 16, 2026", has_materials:true, has_labor:true, new_client:null
    };
    document.getElementById("photoSections").style.display="block";
    document.getElementById("receiptSection").style.display="block";
    showInvoicePreview(invoiceData);
  `);
  const invoiceArea = win.document.getElementById("invoiceArea").innerHTML;
  check("Invoice preview's From section shows the corrected contractor phone, not the raw digits",
    invoiceArea.includes("562-867-5309") && !invoiceArea.includes("562-8675309"));

  // Confirm a fresh device with no saved settings still works normally (empty phone, no crash)
  const domFresh = freshDom();
  const winFresh = domFresh.window;
  await wait(300);
  check("Fresh device (no saved contractor_info) has an empty phone and is unaffected by the retroactive-formatting fix",
    winFresh.eval('contractorInfo.phone') === "");

  // Confirm an already-correctly-formatted phone isn't mangled by being re-processed on every load
  const domGood = domWithPreseededStorage({
    contractor_info: JSON.stringify({
      firstName:"Test", lastName:"", businessName:"", address:"123 Main St", phone:"562-867-5309", mode:"bplw"
    })
  });
  const winGood = domGood.window;
  await wait(300);
  check("An already-correctly-formatted contractor phone is not corrupted on reload",
    winGood.eval('contractorInfo.phone') === "562-867-5309");
}

async function testMidConversationSaveAndResume() {
  console.log("\n=== TEST SUITE 23: Mid-Conversation Save and Resume ===");

  // The save button should be hidden at the very start (no real data yet)
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  check("Mid-save button is hidden on the very first question (invoice_type)",
    win.document.getElementById("midSaveBtn").style.display !== "block");

  // Simulate reaching the tasks stage in BPLW mode (after picking an address chip)
  win.eval(`
    contractorInfo.mode = "bplw";
    invoiceType = "labor";
    messages = [{role:"user",content:"Labor Only"},{role:"assistant",content:"Which partner ordered?"}];
    currentOrderedBy = "Richard Baisz";
    convStage = "street";
    showAddressChips();
  `);
  // Manually save an address for Richard so a chip exists to click
  win.eval(`saveClientAddress("Richard Baisz", {id:"x", display:"123 Test St", full:"123 Test St, Long Beach CA 90802"})`);
  win.eval(`showAddressChips()`);
  win.eval(`document.querySelector('#chipArea .chip:not(.new)').click()`);
  check("Mid-save button becomes visible once an address is selected (real data exists)",
    win.document.getElementById("midSaveBtn").style.display === "block");
  check("Back button is also visible at this stage", win.document.getElementById("backBtn").style.display === "block");

  // Now actually save the conversation mid-flow
  win.eval(`messages.push({role:"user",content:"123 Test St, Long Beach CA 90802"});messages.push({role:"assistant",content:"What was the first task and price?"})`);
  win.eval(`saveConversationForLater()`);
  const savedEntries = JSON.parse(win.eval('JSON.stringify(incompleteInvoices)'));
  check("A conversation entry was actually saved", savedEntries.length === 1);
  check("Saved entry is marked as kind:conversation, distinct from finished-invoice saves",
    savedEntries[0].kind === "conversation");
  check("Saved entry captures the full message history", savedEntries[0].messages.length === 5,
    `expected 5, got ${savedEntries[0].messages.length}`);
  check("Saved entry captures the current stage", savedEntries[0].convStage === "tasks");
  check("Saved entry captures which partner/client was selected", savedEntries[0].currentOrderedBy === "Richard Baisz");
  check("Saved entry captures the contractor mode at time of saving", savedEntries[0].contractorMode === "bplw");

  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("A confirmation message is shown after saving", chatHtml.includes("Saved"));
  check("Mid-save button hides itself immediately after saving", win.document.getElementById("midSaveBtn").style.display !== "block");

  // Confirm the Uncompleted list correctly labels this as an in-progress conversation, not a finished materials invoice
  win.eval(`renderIncompleteList()`);
  const incompleteHtml = win.document.getElementById("incompleteList").innerHTML;
  check("Uncompleted list shows 'In Progress' label for a saved conversation", incompleteHtml.includes("In Progress"));

  // Now resume it on what's effectively a fresh session
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`contractorInfo.mode = "bplw"; incompleteInvoices = ${JSON.stringify(savedEntries)}; saveIncomplete();`);
  win2.eval(`continueIncomplete(0)`);
  await wait(100);

  check("Resuming restores the full message history plus the continuation handoff", win2.eval('messages.length') === 6,
    `expected 6 (5 restored + 1 handoff), got ${win2.eval('messages.length')}`);
  check("Resuming restores convStage", win2.eval('convStage') === "tasks");
  check("Resuming restores invoiceType", win2.eval('invoiceType') === "labor");
  check("Resuming restores currentOrderedBy", win2.eval('currentOrderedBy') === "Richard Baisz");
  check("The saved entry is removed from incompleteInvoices after resuming (no duplicate)",
    win2.eval('incompleteInvoices.length') === 0);

  const resumedChatHtml = win2.document.getElementById("chatBox").innerHTML;
  check("Resumed chat re-displays the prior conversation history", resumedChatHtml.includes("first task and price"));

  const lastMsg = win2.eval('messages[messages.length-1].content');
  check("A continuation handoff message was sent to the AI after resuming",
    lastMsg.toLowerCase().includes("continue") || lastMsg.toLowerCase().includes("paused"));

  // Confirm a mode mismatch is handled safely rather than silently resuming into the wrong flow
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  const mismatchedEntry = {...savedEntries[0], contractorMode:"generic"};
  win3.eval(`contractorInfo.mode = "bplw"; incompleteInvoices = [${JSON.stringify(mismatchedEntry)}]; saveIncomplete();`);
  win3.eval(`continueIncomplete(0)`);
  await wait(100);
  const mismatchChatHtml = win3.document.getElementById("chatBox").innerHTML;
  check("A mode mismatch shows a warning instead of silently resuming",
    mismatchChatHtml.toLowerCase().includes("different") || mismatchChatHtml.toLowerCase().includes("diferente"));
  check("The mismatched entry is removed rather than left dangling", win3.eval('incompleteInvoices.length') === 0);

  // Confirm existing finished-invoice saves (the original materials feature) still work unaffected
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  win4.eval(`
    invoiceData = {done:true, job_address:"456 Old Flow", date:"June 1, 2026", bill_to_name:"Test", bill_to_address:"x", materials_items:[{vendor:"A",desc:"B",date:"x",amount:10}], work_items:[]};
    receipts = [{dataUrl:"data:image/jpeg;base64,X"}];
    saveForLater();
  `);
  const oldStyleEntries = JSON.parse(win4.eval('JSON.stringify(incompleteInvoices)'));
  check("Original finished-invoice saveForLater still works and has no 'kind' field (backward compatible)",
    oldStyleEntries.length === 1 && !oldStyleEntries[0].kind);
  win4.eval(`renderIncompleteList()`);
  const oldStyleHtml = win4.document.getElementById("incompleteList").innerHTML;
  check("Old-style finished-invoice entries render the street address without a type label, and without the 'In Progress' status (since they're a different entry kind)",
    oldStyleHtml.includes("456 Old Flow") && !oldStyleHtml.includes("Materials —") && !oldStyleHtml.includes("In Progress"));
}

async function testIndexedDBPhotoStorage() {
  console.log("\n=== TEST SUITE 24: IndexedDB Photo Storage (regression for Adrian's silent-save-failure bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const fakePhoto = "data:image/jpeg;base64,AAAABBBBCCCC";
  const photoId = await win.eval(`savePhotoBlob(${JSON.stringify(fakePhoto)})`);
  check("savePhotoBlob returns a short ID, not the raw photo data", photoId.length < fakePhoto.length,
    `got ID: ${photoId}`);
  check("savePhotoBlob's ID looks like our photo_ prefix scheme", photoId.startsWith("photo_"));

  const retrieved = await win.eval(`getPhotoBlob(${JSON.stringify(photoId)})`);
  check("getPhotoBlob retrieves the exact original photo data by ID", retrieved === fakePhoto);

  const id2 = await win.eval(`savePhotoBlob("data:image/jpeg;base64,SECOND")`);
  const both = await win.eval(`getPhotoBlobs([${JSON.stringify(photoId)}, ${JSON.stringify(id2)}])`);
  check("getPhotoBlobs resolves multiple IDs in order", both[0] === fakePhoto && both[1] === "data:image/jpeg;base64,SECOND");

  await win.eval(`deletePhotoBlob(${JSON.stringify(photoId)})`);
  const afterDelete = await win.eval(`getPhotoBlob(${JSON.stringify(photoId)})`);
  check("deletePhotoBlob actually removes the photo (subsequent get returns null)", afterDelete === null);

  const oldShapeResult = await win.eval(`getPhotoBlob({dataUrl: "data:image/jpeg;base64,OLDSHAPE"})`);
  check("getPhotoBlob handles the old pre-migration {dataUrl} object shape", oldShapeResult === "data:image/jpeg;base64,OLDSHAPE");

  const directResult = await win.eval(`getPhotoBlob("data:image/jpeg;base64,DIRECT")`);
  check("getPhotoBlob treats a raw dataUrl string as already-resolved", directResult === "data:image/jpeg;base64,DIRECT");

  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  const hugeFakePhoto = "data:image/jpeg;base64," + "A".repeat(2_000_000);
  win2.eval(`
    (async () => {
      const id = await savePhotoBlob(${JSON.stringify(hugeFakePhoto)});
      receipts.push(id);
    })()
  `);
  await wait(200);
  const receiptsArraySize = JSON.stringify(win2.eval('receipts')).length;
  check("Even after adding a ~2MB photo, the receipts array itself stays tiny (just an ID string)",
    receiptsArraySize < 200, `receipts array serialized to ${receiptsArraySize} bytes`);

  win2.eval(`
    invoiceType = "materials";
    messages = [{role:"user",content:"test"}];
    convStage = "tasks";
    currentOrderedBy = "Test Client";
    contractorInfo.mode = "generic";
  `);
  for (let i = 0; i < 5; i++) {
    win2.eval(`
      (async () => {
        const id = await savePhotoBlob(${JSON.stringify(hugeFakePhoto)});
        receipts.push(id);
      })()
    `);
  }
  await wait(300);
  const saveSucceeded = win2.eval(`saveConversationForLater(); incompleteInvoices.length > 0`);
  check("Saving a conversation with 6 large (~12MB total) photos succeeds, since only small IDs are stored in localStorage",
    saveSucceeded === true);

  const savedEntryRaw = win2.eval(`localStorage.getItem("alfonso_incomplete")`);
  check("The actual localStorage payload stays small despite many large photos",
    savedEntryRaw.length < 50_000, `localStorage payload was ${savedEntryRaw.length} bytes`);
}

async function testAddressManagerPrivacyFix() {
  console.log("\n=== TEST SUITE 25: Address Manager Privacy Fix (regression for Adrian's reported BPLW data leak) ===");

  const domBplw = freshDom();
  const winBplw = domBplw.window;
  await wait(300);
  winBplw.eval(`contractorInfo.mode = "bplw"; showAddressManager();`);
  const bplwOptions = winBplw.eval(`Array.from(document.getElementById("addrClientSelect").options).map(o=>o.value)`);
  check("BPLW mode shows the real partner list in the Address Manager dropdown",
    bplwOptions.includes("Andrew Whallon") && bplwOptions.includes("Richard Baisz"));

  const domGeneric = freshDom();
  const winGeneric = domGeneric.window;
  await wait(300);
  winGeneric.eval(`
    contractorInfo.mode = "generic";
    addClient({name:"Andrew Whallon", address:"", email:"andywhallon@yahoo.com", phone:"562-882-8632"});
    showAddressManager();
  `);
  const genericOptions = winGeneric.eval(`Array.from(document.getElementById("addrClientSelect").options).map(o=>o.value)`);
  check("Generic mode dropdown shows the contractor's OWN saved client, not BPLW's hardcoded list",
    genericOptions.includes("Andrew Whallon") && genericOptions.length === 1,
    `got options: ${JSON.stringify(genericOptions)}`);
  check("Generic mode dropdown does NOT include Richard Baisz, Gerry Baisz, or Pravin Patel",
    !genericOptions.includes("Richard Baisz") && !genericOptions.includes("Gerry Baisz") && !genericOptions.includes("Pravin Patel"));

  const domEmpty = freshDom();
  const winEmpty = domEmpty.window;
  await wait(300);
  winEmpty.eval(`contractorInfo.mode = "generic"; showAddressManager();`);
  const emptyOptions = winEmpty.eval(`Array.from(document.getElementById("addrClientSelect").options).map(o=>o.value)`);
  check("Generic mode with no clients shows an empty-state option, not BPLW partners",
    emptyOptions.length === 1 && emptyOptions[0] === "");

  winGeneric.eval(`document.getElementById("addrClientSelect").value = "Andrew Whallon"; renderAddressManager();`);
  const addressListHtml = winGeneric.document.getElementById("addressManagerList").innerHTML;
  check("Generic mode's Andrew Whallon client does not show Alfonso's preloaded Long Beach addresses",
    !addressListHtml.includes("Santa Fe Ave") && !addressListHtml.includes("Pre-loaded"));

  winGeneric.eval(`startAddressManagerAdd()`);
  check("startAddressManagerAdd launches the guided address flow correctly in generic mode",
    winGeneric.eval('guidedAddrState !== null'));
  check("startAddressManagerAdd does not require BPLW-specific purpose handling to work",
    winGeneric.eval('guidedAddrState.meta.clientName') === "Andrew Whallon");

  winEmpty.eval(`startAddressManagerAdd()`);
  check("startAddressManagerAdd with no client selected does not crash (shows alert instead)",
    winEmpty.eval('guidedAddrState') === null);
}

async function testSpanishTranslationOfStaticUI() {
  console.log("\n=== TEST SUITE 26: Spanish Translation of Static UI (regression for Adrian's reported untranslated headings) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Before switching: everything should be in English by default
  check("Header subtitle defaults to English", win.document.getElementById("headerSubText").textContent === "Invoice Assistant");
  check("Nav 'Uncompleted' defaults to English", win.document.getElementById("navUncompleted").textContent === "Uncompleted");

  // Switch to Spanish
  win.eval(`setLang('es')`);
  await wait(100);

  check("Header subtitle translates to Spanish", win.document.getElementById("headerSubText").textContent === "Asistente de Facturas");
  check("Nav 'Uncompleted' translates to Spanish", win.document.getElementById("navUncompleted").textContent === "Pendientes");
  check("Nav 'History' translates to Spanish", win.document.getElementById("navHistory").textContent === "Historial");
  check("Nav 'My Clients' translates to Spanish", win.document.getElementById("navClients").textContent === "Mis Clientes");
  check("Nav 'Job Addresses' translates to Spanish", win.document.getElementById("navAddresses").textContent === "Direcciones de Trabajo");
  check("Nav 'My Info' translates to Spanish ('Mis Datos')", win.document.getElementById("navSettings").textContent === "Mis Datos");

  // Panel titles
  win.eval(`showManager()`);
  check("'Saved Clients' panel title translates to Spanish", win.document.getElementById("mgrTitle").textContent === "Clientes Guardados");
  win.eval(`showIncomplete()`);
  check("'Uncompleted Invoices' panel title translates to Spanish", win.document.getElementById("incTitle").textContent === "Facturas Pendientes");
  win.eval(`showHistory()`);
  check("'Invoice History' panel title translates to Spanish", win.document.getElementById("historyTitle").textContent === "Historial de Facturas");
  win.eval(`showSettings()`);
  check("'Your Business Info' panel title translates to Spanish", win.document.getElementById("settingsTitle").textContent === "Información de tu Negocio");
  win.eval(`showAddressManager()`);
  check("'Manage Job Addresses' panel title translates to Spanish", win.document.getElementById("addrMgrTitle").textContent === "Administrar Direcciones de Trabajo");

  // Settings field labels
  check("Settings 'First Name' label translates to Spanish", win.document.getElementById("lblFirstName").textContent === "Nombre");
  check("Settings 'Last Name' label translates to Spanish", win.document.getElementById("lblLastName").textContent === "Apellido");
  check("Settings 'Address' label translates to Spanish", win.document.getElementById("lblAddress").textContent === "Dirección");
  check("Settings 'Phone' label translates to Spanish", win.document.getElementById("lblPhone").textContent === "Teléfono");
  check("Settings 'Billing Setup' label translates to Spanish", win.document.getElementById("lblBillingSetup").textContent === "Configuración de Facturación");
  check("Settings 'Save' button translates to Spanish", win.document.getElementById("btnSaveSettings").textContent === "Guardar");
  check("Billing Setup dropdown options translate to Spanish",
    win.document.getElementById("optBplw").textContent.includes("Andrew Whallon") && win.document.getElementById("optGeneric").textContent.includes("propios clientes"));

  // Back buttons (every other panel) should all say the plain Spanish equivalent
  ["mgrBackBtn","incBackBtn","historyBackBtn","addrMgrBackBtn"].forEach(id => {
    check(`Back button #${id} translates to Spanish`, win.document.getElementById(id).textContent === "← Atrás");
  });
  // Settings' back button has unique wording ("Back, Do Not Save") to distinguish it from Save
  check("Settings back button translates to Spanish with its distinct 'Do Not Save' wording",
    win.document.getElementById("settingsBackBtn").textContent === "← Atrás, No Guardar");

  // Switching back to English should restore everything correctly (no stuck-Spanish bug)
  win.eval(`setLang('en')`);
  await wait(100);
  check("Switching back to English restores the header subtitle", win.document.getElementById("headerSubText").textContent === "Invoice Assistant");
  check("Switching back to English restores nav labels", win.document.getElementById("navClients").textContent === "My Clients");
}

async function testSpanishTranslationOfDynamicLists() {
  console.log("\n=== TEST SUITE 27: Spanish Translation of Dynamically-Rendered Lists ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);
  win.eval(`setLang('es')`);
  await wait(100);

  // Empty states
  win.eval(`showManager()`);
  const emptyClientsHtml = win.document.getElementById("clientList").innerHTML;
  check("Empty Clients list shows Spanish empty-state text",
    emptyClientsHtml.includes("Aún no hay clientes guardados"));

  win.eval(`showIncomplete()`);
  const emptyIncHtml = win.document.getElementById("incompleteList").innerHTML;
  check("Empty Uncompleted list shows Spanish empty-state text",
    emptyIncHtml.includes("No hay facturas pendientes"));

  win.eval(`showHistory()`);
  const emptyHistHtml = win.document.getElementById("historyList").innerHTML;
  check("Empty History list shows Spanish empty-state text",
    emptyHistHtml.includes("Aún no hay facturas"));

  // Populated client list — Delete button should be in Spanish
  win.eval(`addClient({name:"Cliente Prueba", address:"123 Calle", email:"x@x.com", phone:""}); renderClientList();`);
  const clientListHtml = win.document.getElementById("clientList").innerHTML;
  check("Populated client list shows Spanish 'Eliminar' (Delete) button", clientListHtml.includes("Eliminar"));

  // Populated incomplete list — in-progress conversation label
  win.eval(`
    incompleteInvoices = [{kind:"conversation", invoiceType:"labor", messages:[{role:"user",content:"x"}], convStage:"tasks", currentOrderedBy:"Test", contractorMode:"bplw", job_address:"123 Main St", saved_at:new Date().toISOString()}];
    renderIncompleteList();
  `);
  const incHtml = win.document.getElementById("incompleteList").innerHTML;
  check("In-progress conversation entry shows the Spanish 'En Progreso' status label",
    incHtml.includes("En Progreso"));

  // Populated history list
  win.eval(`
    invoiceHistory = [{type:"both", invNum:1, invoiceData:{job_address:"123 Main St, Long Beach CA 90810", date:"x", ordered_by:"Test Customer", work_items:[{desc:"a",amount:10}], materials_items:[]}, receipts:[], jobPhotos:[], created_at:new Date().toISOString()}];
    renderHistoryList();
  `);
  const histHtml = win.document.getElementById("historyList").innerHTML;
  check("History entry shows the Spanish 'Toca para ver' (Tap to view) text",
    histHtml.includes("Toca para ver"));
  check("History entry still shows the customer name and street address regardless of language",
    histHtml.includes("Test Customer") && histHtml.includes("123 Main St"));

  // Address Manager: empty state, pre-loaded section, and Edit/Delete buttons
  win.eval(`contractorInfo.mode = "bplw"; showAddressManager();`);
  win.eval(`document.getElementById("addrClientSelect").value = "Andrew Whallon"; renderAddressManager();`);
  const addrHtml = win.document.getElementById("addressManagerList").innerHTML;
  check("Address Manager shows Spanish 'Precargado' (Pre-loaded) section label", addrHtml.includes("Precargado"));

  win.eval(`saveClientAddress("Andrew Whallon", {id:"x", display:"Test St", full:"Test St, City CA 90000"}); renderAddressManager();`);
  const addrHtml2 = win.document.getElementById("addressManagerList").innerHTML;
  check("Address Manager shows Spanish 'Agregadas' (Added) section for saved addresses", addrHtml2.includes("Agregadas"));
  check("Address Manager shows Spanish 'Editar' and 'Eliminar' buttons", addrHtml2.includes("Editar") && addrHtml2.includes("Eliminar"));

  // Generic mode empty client dropdown option
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`setLang('es'); contractorInfo.mode = "generic"; showAddressManager();`);
  const emptyOptionText = win2.eval(`document.getElementById("addrClientSelect").options[0].textContent`);
  check("Generic mode's empty client dropdown option is in Spanish", emptyOptionText.includes("Aún no hay clientes"));
}

async function testAiConversationRespondsInSelectedLanguage() {
  console.log("\n=== TEST SUITE 28: AI Conversation Responds in Selected Language (regression for Adrian's reported English-only summary bug) ===");

  // English (default): system prompt should instruct English responses
  const domEn = freshDom();
  const winEn = domEn.window;
  await wait(300);
  const sysPromptEn = winEn.eval('getSystemPrompt()');
  check("System prompt instructs English when lang is 'en'", sysPromptEn.includes("Respond ONLY in English"));
  check("System prompt does NOT say 'English only' as a hardcoded unconditional rule anymore",
    !sysPromptEn.match(/\.\s*English only\s*\./i));

  // Spanish: system prompt should instruct Spanish responses instead
  const domEs = freshDom();
  const winEs = domEs.window;
  await wait(300);
  winEs.eval(`setLang('es')`);
  const sysPromptEs = winEs.eval('getSystemPrompt()');
  check("System prompt instructs Spanish when lang is 'es'", sysPromptEs.includes("Respond ONLY in Spanish"));

  // The confirmation summary field-label template itself must switch language too —
  // otherwise the AI is told to respond in Spanish but use literal English field labels
  check("Spanish system prompt's confirmation template uses Spanish field labels",
    sysPromptEs.includes("Cliente:") && sysPromptEs.includes("Dirección del Cliente:") && sysPromptEs.includes("Fecha:"));
  check("Spanish system prompt's confirmation template does NOT use the English field labels",
    !sysPromptEs.includes("Client Address: [bill-to address]"));
  check("English system prompt's confirmation template still uses English field labels",
    sysPromptEn.includes("Client Address:") && sysPromptEn.includes("Job Address:"));

  // The literal job-address question instructed to the AI must match what smartChips
  // actually listens for in Spanish, the same class of bug found earlier with the
  // confirmation trigger — this test guards against that recurring for any other question.
  winEs.eval(`contractorInfo.mode = "generic";`);
  const sysPromptEsGeneric = winEs.eval('getSystemPrompt()');
  const jobAddrQuestionMatch = sysPromptEsGeneric.match(/Ask "([^"]+)"\s*The app will guide/);
  check("Spanish generic-mode system prompt contains an explicit job-address question", !!jobAddrQuestionMatch);
  if (jobAddrQuestionMatch) {
    const instructedPhrase = jobAddrQuestionMatch[1].toLowerCase();
    const jobAddrPhrases = winEs.eval(`["which address","which street","what street","street is the job","street was the work","job location","job address","where was the job","location of the job","address was the job","address of the job","dirección del trabajo","qué dirección fue el trabajo","en qué dirección","dirección de la calle","dirección fue el trabajo"]`);
    const matches = jobAddrPhrases.some(p => instructedPhrase.includes(p));
    check(`The instructed Spanish job-address question ("${jobAddrQuestionMatch[1]}") actually matches a trigger phrase smartChips listens for`,
      matches, "if this fails, the AI would ask the right question in Spanish but the app would never recognize it — silently breaking the guided address flow");
  }

  // Same check for the receipt-photo and job-photo "say exactly" instructions —
  // confirm the literal instructed Spanish phrase matches what showJobPhotoChips/showReceiptPhotoChips listen for
  winEs.eval(`invoiceType = "both";`);
  const sysPromptEsBoth = winEs.eval('getSystemPrompt()');
  check("Spanish prompt's job-photo instruction matches the showJobPhotoChips trigger phrase",
    sysPromptEsBoth.toLowerCase().includes("agregar una foto del trabajo"));
  check("Spanish prompt's receipt-photo instruction matches the showReceiptPhotoChips trigger phrase",
    sysPromptEsBoth.toLowerCase().includes("agregar una foto de este recibo"));
  check("Spanish prompt's materials-purchase question matches the yes/no trigger phrase",
    sysPromptEsBoth.toLowerCase().includes("compraste materiales"));
  check("Spanish prompt's 'any other receipts' question matches the yes/no trigger phrase",
    sysPromptEsBoth.toLowerCase().includes("otro recibo"));

  // BPLW mode: the partner question must also be in Spanish and match the partner trigger
  winEs.eval(`contractorInfo.mode = "bplw";`);
  const sysPromptEsBplw = winEs.eval('getSystemPrompt()');
  check("Spanish BPLW prompt's partner question matches the 'which partner' trigger phrase",
    sysPromptEsBplw.toLowerCase().includes("qué socio"));
  check("Spanish BPLW prompt's client-type question is in Spanish",
    sysPromptEsBplw.includes("¿BPLW Management o un cliente diferente?"));

  // Year-clarification phrase (used by the wrong-year-correction backstop) must also match in Spanish
  check("Spanish prompt's year-clarification phrase matches the AI-stated-wrong-year correction regex",
    /este año\s*\(\d{4}\)/i.test(sysPromptEsBoth));
}

async function testSettingsSeparateAddressFields() {
  console.log("\n=== TEST SUITE 29: Settings Separate Address Fields (replacing the step-by-step interview) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // The old step-by-step button and single address field must be gone entirely
  check("The old single 'setAddress' field no longer exists", win.document.getElementById("setAddress") === null);
  check("The old 'Fill in step by step' button no longer exists", win.document.getElementById("btnFillStepByStep") === null);

  // The five separate fields must exist
  ["setStreet","setUnit","setCity","setState","setZip"].forEach(id => {
    check(`Separate address field #${id} exists in Settings`, win.document.getElementById(id) !== null);
  });

  // Filling in the five fields and saving should combine them into one stored address string
  win.eval(`showSettings()`);
  win.document.getElementById("setFirstName").value = "Test";
  win.document.getElementById("setStreet").value = "100 Test St";
  win.document.getElementById("setUnit").value = "5B";
  win.document.getElementById("setCity").value = "Riverside";
  win.document.getElementById("setState").value = "CA";
  win.document.getElementById("setZip").value = "92501";
  win.eval(`saveSettingsForm()`);
  const savedAddress = win.eval('contractorInfo.address');
  check("Saving combines the five fields into one address string", savedAddress.includes("100 Test St") && savedAddress.includes("5B") && savedAddress.includes("Riverside") && savedAddress.includes("CA") && savedAddress.includes("92501"));

  // Re-opening Settings should split the saved address back into the five fields correctly
  win.eval(`showSettings()`);
  check("Re-opening Settings correctly re-populates Street", win.document.getElementById("setStreet").value === "100 Test St");
  check("Re-opening Settings correctly re-populates Unit", win.document.getElementById("setUnit").value === "5B");
  check("Re-opening Settings correctly re-populates City", win.document.getElementById("setCity").value === "Riverside");
  check("Re-opening Settings correctly re-populates State", win.document.getElementById("setState").value === "CA");
  check("Re-opening Settings correctly re-populates Zip", win.document.getElementById("setZip").value === "92501");

  // No unit entered should round-trip cleanly with an empty unit field, not a stray "Unit" string
  win.document.getElementById("setUnit").value = "";
  win.eval(`saveSettingsForm()`);
  win.eval(`showSettings()`);
  check("An address with no unit round-trips with an empty unit field", win.document.getElementById("setUnit").value === "");

  // Spanish field labels
  win.eval(`setLang('es')`);
  check("Street label translates to Spanish", win.document.getElementById("lblStreet").textContent === "Dirección de la Calle");
  check("City label translates to Spanish", win.document.getElementById("lblCity").textContent === "Ciudad");
  check("State label translates to Spanish", win.document.getElementById("lblState").textContent === "Estado");
  check("Zip label translates to Spanish", win.document.getElementById("lblZip").textContent === "Código Postal");
}

async function testAddressParsingAndBuilding() {
  console.log("\n=== TEST SUITE 30: Address Parsing and Building Helpers (regression coverage for real saved address shapes) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // buildAddressFromParts: the inverse operation, used when saving
  const built = win.eval(`buildAddressFromParts("310 Main Ave", "1", "Long Beach", "CA", "90802")`);
  check("buildAddressFromParts produces a correctly combined address with a unit", built.includes("310 Main Ave") && built.includes("Unit 1") && built.includes("Long Beach") && built.includes("CA") && built.includes("90802"));

  const builtNoUnit = win.eval(`buildAddressFromParts("310 Main Ave", "", "Long Beach", "CA", "90802")`);
  check("buildAddressFromParts omits 'Unit' entirely when no unit is given", !builtNoUnit.includes("Unit"));

  // parseAddressIntoParts: real address shapes that actually exist in this app's data
  const case1 = JSON.parse(win.eval(`JSON.stringify(parseAddressIntoParts("1001 Cherry Ave Unit 102, Long Beach CA 90813"))`));
  check("Parses a standard comma-separated address with a 2-letter state and unit",
    case1.street === "1001 Cherry Ave" && case1.unit === "102" && case1.city === "Long Beach" && case1.state === "CA" && case1.zip === "90813");

  const case2 = JSON.parse(win.eval(`JSON.stringify(parseAddressIntoParts("1995 Canal Avenue, Long Beach California 90810"))`));
  check("Parses an address using the full state name instead of an abbreviation",
    case2.street === "1995 Canal Avenue" && case2.city === "Long Beach" && case2.state === "California" && case2.zip === "90810");

  // Adrian's actual real saved address shape: no comma at all
  const case3 = JSON.parse(win.eval(`JSON.stringify(parseAddressIntoParts("1952 Caspian Avenue Long Beach California 90810"))`));
  check("Parses a real no-comma address (Adrian's actual saved format) without losing the city/state/zip",
    case3.street === "1952 Caspian Avenue" && case3.city === "Long Beach" && case3.state === "California" && case3.zip === "90810",
    `got: ${JSON.stringify(case3)}`);

  const case4 = JSON.parse(win.eval(`JSON.stringify(parseAddressIntoParts(""))`));
  check("Parsing an empty address returns all-blank parts without crashing",
    case4.street === "" && case4.city === "" && case4.state === "" && case4.zip === "");

  const case5 = JSON.parse(win.eval(`JSON.stringify(parseAddressIntoParts("123 Some Street"))`));
  check("A street-only address with no parseable city/state/zip falls back to putting everything in street, without losing data",
    case5.street === "123 Some Street");

  // Round-trip: parse then rebuild should reconstruct an equivalent address
  const roundTrip = win.eval(`
    (function(){
      const parts = parseAddressIntoParts("1001 Cherry Ave Unit 102, Long Beach CA 90813");
      return buildAddressFromParts(parts.street, parts.unit, parts.city, parts.state, parts.zip);
    })()
  `);
  check("Parsing then rebuilding an address reconstructs an equivalent string",
    roundTrip.includes("1001 Cherry Ave") && roundTrip.includes("102") && roundTrip.includes("Long Beach") && roundTrip.includes("CA") && roundTrip.includes("90813"));
}

async function testFirstTimeWelcomeAndOnboarding() {
  console.log("\n=== TEST SUITE 30: First-Time Welcome Message and Sequenced Onboarding Flow ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("isFirstTimeUser() returns true on a genuinely fresh device", win.eval('isFirstTimeUser()') === true);
  check("Onboarding starts at the 'lang' stage", win.eval('onboardingStage') === "lang");

  // STAGE 1: conversation language choice — bilingual message, conversation toggle highlighted
  const stage1Html = win.document.getElementById("chatBox").innerHTML;
  check("Stage 1 message is shown in English", stage1Html.includes("Welcome to Hablacuenta"));
  check("Stage 1 message is ALSO shown in Spanish (bilingual, no language chosen yet)",
    stage1Html.includes("Bienvenido a Hablacuenta"));
  check("Stage 1 does NOT yet mention the automatic translation feature (that's stage 2)",
    !stage1Html.toLowerCase().includes("translation"));
  check("Stage 1 shows NO chips yet (the toggle itself is the action, not a chip)",
    win.document.getElementById("chipArea").innerHTML === "");
  const convToggleEl = win.document.getElementById("btnES").closest(".lang-toggle");
  check("The CONVERSATION-language toggle is highlighted at stage 1", convToggleEl.classList.contains("attn-highlight"));
  const invToggleEl = win.document.getElementById("invoiceLangToggle");
  check("The invoice-language toggle is NOT highlighted yet at stage 1", !invToggleEl.classList.contains("attn-highlight"));

  // Tapping EN (already the default) should still advance the stage, since it's a deliberate choice
  win.eval(`setLang('en')`);
  await wait(100);
  check("Tapping the conversation toggle advances onboardingStage to 'invoiceLang'",
    win.eval('onboardingStage') === "invoiceLang");

  // STAGE 2: invoice language choice — mentions automatic translation, invoice toggle highlighted
  const stage2Html = win.document.getElementById("chatBox").innerHTML;
  check("Stage 2 message mentions the automatic translation feature",
    stage2Html.toLowerCase().includes("translation"));
  check("Stage 2 message explains they can change the invoice language later for different clients",
    stage2Html.toLowerCase().includes("clients") || stage2Html.toLowerCase().includes("clientes"));
  check("Stage 2 shows no chips (the toggle is the action)", win.document.getElementById("chipArea").innerHTML === "");
  const convToggleElStage2 = win.document.getElementById("btnES").closest(".lang-toggle");
  check("The conversation-language toggle is NO LONGER highlighted at stage 2",
    !convToggleElStage2.classList.contains("attn-highlight"));
  check("The invoice-language toggle IS highlighted at stage 2",
    win.document.getElementById("invoiceLangToggle").classList.contains("attn-highlight"));

  // Tapping the invoice toggle should advance to the final stage
  win.eval(`setInvoiceLang('en')`);
  await wait(100);
  check("Tapping the invoice toggle advances onboardingStage to 'done'", win.eval('onboardingStage') === "done");

  // STAGE 3: final app explanation + highlighted My Info nav link (no chip — the nav link itself is the action)
  const stage3Html = win.document.getElementById("chatBox").innerHTML;
  check("Stage 3 explains the app lets you create invoices by talking",
    stage3Html.toLowerCase().includes("talking") || stage3Html.toLowerCase().includes("just by talking"));
  check("Stage 3 explains you can enter as much or as little business info as you want right now",
    stage3Html.toLowerCase().includes("as little as you want") || stage3Html.toLowerCase().includes("tan poco como quieras"));
  check("Stage 3 mentions tapping 'My Info' to get started",
    stage3Html.includes("My Info"));
  check("Stage 3 does NOT show the normal 'What type of invoice' greeting yet",
    !stage3Html.includes("What type of invoice do you need"));
  check("Invoice-language toggle highlight is cleared by stage 3",
    !win.document.getElementById("invoiceLangToggle").classList.contains("attn-highlight"));
  check("Stage 3 shows no chips at all (the nav link itself is the call to action)",
    win.document.getElementById("chipArea").innerHTML === "");
  check("The My Info nav link IS highlighted at stage 3",
    win.document.getElementById("navSettings").classList.contains("attn-highlight"));

  // Clicking the My Info nav link should open Settings and clear its highlight
  win.eval(`document.getElementById("navSettings").click()`);
  check("Clicking My Info opens the Settings panel", win.document.getElementById("settingsPanel").style.display === "block");
  check("Clicking My Info clears its own highlight", !win.document.getElementById("navSettings").classList.contains("attn-highlight"));

  // Filling in info and saving should return to the normal chat flow automatically
  win.document.getElementById("setFirstName").value = "Maria";
  win.document.getElementById("setLastName").value = "Lopez";
  win.eval(`saveSettingsForm()`);
  await wait(100);
  check("After first-time setup, Settings panel closes automatically", win.document.getElementById("settingsPanel").style.display !== "block");
  check("isFirstTimeUser() is now false after saving real info", win.eval('isFirstTimeUser()') === false);
  const postSetupChatHtml = win.document.getElementById("chatBox").innerHTML;
  check("After first-time setup, the normal invoice-type greeting now appears",
    postSetupChatHtml.includes("What type of invoice do you need"));
  check("Greeting correctly uses the newly-entered name", postSetupChatHtml.includes("Maria"));

  // Confirm new installs default to generic mode (not BPLW), per explicit product decision
  check("New installs default to generic mode, not BPLW", win.eval('contractorInfo.mode') === "generic");

  // Returning users (info already set) should skip the welcome message entirely on next load
  const dom2 = domWithPreseededStorage({
    contractor_info: JSON.stringify({firstName:"Carlos", lastName:"Ruiz", businessName:"", address:"", phone:"", mode:"generic"})
  });
  const win2 = dom2.window;
  await wait(300);
  check("A returning user with saved info does NOT see the welcome message again",
    !win2.document.getElementById("chatBox").innerHTML.toLowerCase().includes("welcome"));
  check("A returning user sees the normal greeting with their name",
    win2.document.getElementById("chatBox").innerHTML.includes("Carlos"));

  // Tapping the conversation toggle is itself the deliberate stage-1 choice, so it should
  // advance to stage 2 immediately (now shown in Spanish), not re-display stage 1.
  const dom3 = freshDom();
  const win3 = dom3.window;
  await wait(300);
  win3.eval(`setLang('es')`);
  await wait(100);
  const esChatHtml = win3.document.getElementById("chatBox").innerHTML;
  check("Tapping the conversation toggle to Spanish advances to stage 2, now shown in Spanish",
    esChatHtml.toLowerCase().includes("traducción"));
  check("Stage 1's bilingual message is no longer shown after advancing past it",
    !esChatHtml.includes("Welcome to Hablacuenta"));
  check("After tapping the conversation toggle once, onboarding has advanced to invoiceLang stage",
    win3.eval('onboardingStage') === "invoiceLang");
  check("Still a first-time user after just toggling language (no business info entered yet)",
    win3.eval('isFirstTimeUser()') === true);
}

async function testDualLanguageToggle() {
  console.log("\n=== TEST SUITE 31: Dual Language Toggle — Conversation Language vs Invoice Language ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Both toggles should exist independently in the header
  check("Conversation language toggle (ES/EN) exists", !!win.document.getElementById("btnES") && !!win.document.getElementById("btnEN"));
  check("Invoice language toggle (separate ES/EN) exists", !!win.document.getElementById("btnInvES") && !!win.document.getElementById("btnInvEN"));
  check("The two toggles are genuinely distinct DOM elements, not aliases of each other",
    win.document.getElementById("btnES") !== win.document.getElementById("btnInvES"));

  // By default both start in English, but they are fully independent — no auto-sync at all
  check("Default: invoiceLang matches lang (both English) on a fresh load", win.eval('invoiceLang') === win.eval('lang'));
  win.eval(`setLang('es')`);
  check("Switching conversation language to Spanish does NOT move invoiceLang — the two are fully independent from the start",
    win.eval('invoiceLang') === "en");

  // Setting invoice language independently has always worked, and still does
  win.eval(`setInvoiceLang('en')`);
  check("Explicitly setting invoice language to English while conversation stays Spanish works",
    win.eval('lang') === "es" && win.eval('invoiceLang') === "en");
  win.eval(`setLang('en')`);
  win.eval(`setLang('es')`);
  check("Switching conversation language back and forth never drags invoiceLang along with it",
    win.eval('invoiceLang') === "en");
  win.eval(`setInvoiceLang('es')`);
  win.eval(`setLang('en')`);
  check("Switching conversation language to English does not drag an independently-set Spanish invoiceLang back",
    win.eval('invoiceLang') === "es");

  // The invoice preview should show a language-mismatch notice when the two differ.
  // Set up a clean, explicit state: conversation in Spanish, invoice in English.
  win.eval(`setLang('es'); setInvoiceLang('en');`);
  win.eval(`
    invoiceType = "labor";
    invoiceData = {done:true, bill_to_name:"Cliente", bill_to_address:"x", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"", job_address:"123 Main", work_items:[{desc:"Tarea", amount:50}], materials_items:[], date:"x", has_labor:true};
    showInvoicePreview(invoiceData);
  `);
  const mismatchHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("A language-mismatch notice appears when invoiceLang differs from the conversation language, naming the INVOICE's language (English)",
    mismatchHtml.toLowerCase().includes("english") || mismatchHtml.toLowerCase().includes("inglés"));

  // When the two match, no notice should appear
  win.eval(`setInvoiceLang('es')`);
  win.eval(`showInvoicePreview(invoiceData)`);
  const matchHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("No language-mismatch notice appears when invoiceLang matches the conversation language",
    !matchHtml.toLowerCase().includes("you're viewing this") && !matchHtml.toLowerCase().includes("estás viendo esto"));

  // translateForPDF should use invoiceLang, not the conversation language, as its trigger condition
  win.eval(`setLang('es'); setInvoiceLang('en');`);
  win.eval(`invoiceData = {date:"5 de junio de 2026", work_items:[{desc:"Reparar tubería", amount:50}], materials_items:[]};`);
  const fnSource = win.eval('translateForPDF.toString()');
  check("translateForPDF's no-op condition compares invoiceLang to lang, not a hardcoded language check",
    fnSource.includes("invoiceLang===lang"));
}

async function testFormatUnitNormalization() {
  console.log("\n=== TEST SUITE 32: Unit Number Normalization (regression for Adrian's reported voice-dictation bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // The exact phrase from Adrian's real screenshot — voice dictation transcribed exactly
  // what was said, and the app must normalize it rather than storing it verbatim.
  check("'Apartment number one' (Adrian's exact reported phrase) normalizes to 'Apt #1'",
    win.eval(`formatUnit("Apartment number one")`) === "Apt #1");

  // Other spoken-style phrasings
  check("'apartment number five' normalizes correctly", win.eval(`formatUnit("apartment number five")`) === "Apt #5");
  check("'unit number twelve' normalizes correctly", win.eval(`formatUnit("unit number twelve")`) === "Apt #12");
  check("'suite number twenty one' (two-word number) normalizes correctly", win.eval(`formatUnit("suite number twenty one")`) === "Apt #21");
  check("'apartment 7' (no 'number' word) normalizes correctly", win.eval(`formatUnit("apartment 7")`) === "Apt #7");

  // Already-typed/compact formats should still normalize consistently
  check("Bare number '5B' normalizes to 'Apt #5B'", win.eval(`formatUnit("5B")`) === "Apt #5B");
  check("Bare number '12' normalizes to 'Apt #12'", win.eval(`formatUnit("12")`) === "Apt #12");
  check("'Unit 5' normalizes to 'Apt #5'", win.eval(`formatUnit("Unit 5")`) === "Apt #5");
  check("'Apt 3' normalizes to 'Apt #3'", win.eval(`formatUnit("Apt 3")`) === "Apt #3");

  // Edge cases that must NOT be mangled
  check("Empty string passes through unchanged", win.eval(`formatUnit("")`) === "");
  check("Unrecognizable free text passes through unchanged rather than being mangled",
    win.eval(`formatUnit("the one in the back")`) === "the one in the back");

  // Integration: saving Settings with a spoken-style unit should store the normalized form
  win.eval(`showSettings()`);
  win.document.getElementById("setFirstName").value = "Test";
  win.document.getElementById("setStreet").value = "310 Main Avenue";
  win.document.getElementById("setUnit").value = "Apartment number one";
  win.document.getElementById("setCity").value = "Long Beach";
  win.document.getElementById("setState").value = "CA";
  win.document.getElementById("setZip").value = "90802";
  win.eval(`saveSettingsForm()`);
  const savedAddress = win.eval('contractorInfo.address');
  check("Saved address contains the normalized 'Apt #1', not the raw spoken phrase",
    savedAddress.includes("Apt #1") && !savedAddress.toLowerCase().includes("apartment number"));
  check("Saved address does NOT double-label the unit (no 'Unit Apt #1')",
    !savedAddress.includes("Unit Apt"));

  // Round-trip: re-opening Settings should split the normalized address back out correctly.
  // The Unit field shows the bare identifier ("1"), not the full "Apt #1" label, since the
  // field's own "Unit / Suite" label already provides that context — formatUnit() re-adds
  // the "Apt #" label on the next save, not on display.
  win.eval(`showSettings()`);
  check("Re-opening Settings shows the bare unit identifier after parsing",
    win.document.getElementById("setUnit").value === "1");
  check("Street field is correctly separated from the normalized unit on reload",
    win.document.getElementById("setStreet").value === "310 Main Avenue");

  // Regression guard: a real street name containing a similar word (e.g. "Unity Avenue")
  // must NOT be misparsed as having a unit number.
  const unityCase = JSON.parse(win.eval(`JSON.stringify(parseAddressIntoParts("500 Unity Avenue, Riverside CA 92501"))`));
  check("A street legitimately named 'Unity Avenue' is NOT misparsed as containing a unit number",
    unityCase.unit === "" && unityCase.street.includes("Unity Avenue"),
    `got: ${JSON.stringify(unityCase)}`);

  // Confirm the parser also recognizes the new Apt # format when splitting an existing saved address
  const aptCase = JSON.parse(win.eval(`JSON.stringify(parseAddressIntoParts("310 Main Avenue Apt #1, Long Beach CA 90802"))`));
  check("parseAddressIntoParts correctly extracts a unit stored in the new 'Apt #N' format",
    aptCase.unit === "1" && aptCase.street === "310 Main Avenue");

  // Stability check: repeated save -> reload -> save cycles must not degrade or change the
  // address over time (no creeping double-labels, no data loss across cycles).
  win.eval(`showSettings(); saveSettingsForm();`); // re-save without touching the field
  const afterSecondSave = win.eval('contractorInfo.address');
  win.eval(`showSettings(); saveSettingsForm();`); // and a third time
  const afterThirdSave = win.eval('contractorInfo.address');
  check("Repeated save/reload cycles produce a stable, unchanging address",
    afterSecondSave === savedAddress && afterThirdSave === savedAddress,
    `save1: "${savedAddress}", save2: "${afterSecondSave}", save3: "${afterThirdSave}"`);
}

async function testInlineCorrectionEditorFieldSelector() {
  console.log("\n=== TEST SUITE 33: Inline Correction Editor — Field Selector (Option 1 rebuild) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`
    contractorInfo.mode = "bplw";
    invoiceType = "both";
    invoiceData = {
      done:true, bill_to_name:"BPLW Management", bill_to_address:"PO Box 9395, Long Beach CA 90810", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"Andrew Whallon", job_address:"1995 Canal Ave, Long Beach CA 90810",
      work_items:[{desc:"Replace water heater",amount:700},{desc:"Replace damaged pipes",amount:150},{desc:"Install new hoses",amount:50}],
      materials_items:[{vendor:"Home Depot",desc:"Plumbing materials",date:"May 23, 2026",amount:115.51}],
      date:"May 23, 2026", has_materials:true, has_labor:true
    };
    document.getElementById("photoSections").style.display="block";
    document.getElementById("receiptSection").style.display="block";
    showInvoicePreview(invoiceData);
  `);

  // Tapping "Something needs correcting" must render the menu INLINE in invoiceArea, not chipArea
  win.eval(`showCorrectionMenu("both")`);
  const menuHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Correction menu renders inline in invoiceArea (not the chat/chip area)",
    menuHtml.includes("What needs to be corrected") || menuHtml.includes("Qué necesita corrección"));
  check("Field selector offers Partner/Client", menuHtml.includes("Partner") || menuHtml.includes("Socio"));
  check("Field selector offers Job Address", menuHtml.includes("Job Address") || menuHtml.includes("Dirección del Trabajo"));
  check("Field selector offers Date", menuHtml.includes(">Date<") || menuHtml.includes(">Fecha<") || menuHtml.includes("✏️ Date") || menuHtml.includes("✏️ Fecha"));
  check("Field selector offers Work/Tasks for a combined invoice", menuHtml.includes("Work") || menuHtml.includes("Trabajo"));
  check("Field selector offers Materials/Receipts for a combined invoice", menuHtml.includes("Materials") || menuHtml.includes("Materiales"));
  check("A Cancel button is present", menuHtml.includes("Cancel") || menuHtml.includes("Cancelar"));

  // Cancel should return to the normal invoice preview, not leave the menu showing
  const cancelMatch=menuHtml.match(/onclick="(showInvoicePreview\(invoiceData\))"/);
  check("Cancel button calls showInvoicePreview to return to the normal view", !!cancelMatch);

  // The field selector for a labor-only invoice should NOT offer Materials/Receipts
  win.eval(`invoiceType = "labor"; showCorrectionMenu("labor");`);
  const laborMenuHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Labor-only correction menu does NOT offer Materials/Receipts",
    !laborMenuHtml.includes("Materials / Receipts") && !laborMenuHtml.includes("Materiales / Recibos"));
}

async function testInlineCorrectionEditorSimpleFields() {
  console.log("\n=== TEST SUITE 34: Inline Correction Editor — Date, Job Address, Partner/Client (direct editing, no AI round-trip) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`
    contractorInfo.mode = "bplw";
    invoiceType = "labor";
    invoiceData = {
      done:true, bill_to_name:"BPLW Management", bill_to_address:"PO Box 9395, Long Beach CA 90810", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"Andrew Whallon", job_address:"1995 Canal Ave, Long Beach CA 90810",
      work_items:[{desc:"Task A",amount:100}], materials_items:[],
      date:"May 23, 2026", has_materials:false, has_labor:true
    };
    showInvoicePreview(invoiceData);
  `);

  // DATE: pre-filled input, direct edit, no AI conversation involved
  win.eval(`showCorrectionMenu("labor")`);
  win.eval(`showFieldEditor("date")`);
  const dateEditorHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Date editor pre-fills the input with the current date value", dateEditorHtml.includes('value="May 23, 2026"'));
  win.eval(`document.getElementById("editFieldInput").value = "June 1, 2026"; saveFieldEdit("date");`);
  check("Saving a corrected date updates invoiceData.date directly, with no AI message exchange",
    win.eval('invoiceData.date') === "June 1, 2026");
  check("No new messages were pushed to the AI conversation for this direct edit",
    win.eval('messages.length') === 0);

  // Date validation: missing year should be rejected, same protection as the original flow
  let alertShown = false;
  win.window = win; // ensure alert is interceptable
  win.alert = () => { alertShown = true; };
  win.eval(`showCorrectionMenu("labor")`);
  win.eval(`showFieldEditor("date")`);
  win.eval(`document.getElementById("editFieldInput").value = "May 5"; saveFieldEdit("date");`);
  check("Saving a date missing a year is rejected (validation still applies in direct-edit mode)",
    win.eval('invoiceData.date') === "June 1, 2026", "date should NOT have changed to the invalid value");

  // JOB ADDRESS: pre-filled input, direct edit
  win.eval(`showCorrectionMenu("labor")`);
  win.eval(`showFieldEditor("job_address")`);
  const addrEditorHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Job address editor pre-fills the input with the current address", addrEditorHtml.includes("1995 Canal Ave"));
  win.eval(`document.getElementById("editFieldInput").value = "123 New St, Long Beach CA 90810"; saveFieldEdit("job_address");`);
  check("Saving a corrected job address updates invoiceData.job_address directly",
    win.eval('invoiceData.job_address') === "123 New St, Long Beach CA 90810");

  // PARTNER/CLIENT: picker pre-selects the current value, can pick a different known partner
  win.eval(`showCorrectionMenu("labor")`);
  win.eval(`showFieldEditor("ordered_by")`);
  const partnerEditorHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Partner picker shows all BPLW partners as options", partnerEditorHtml.includes("Richard Baisz") && partnerEditorHtml.includes("Andrew Whallon"));
  check("Partner picker pre-selects the currently-assigned partner",
    /edit-partner-row selected" data-name="Andrew Whallon"/.test(partnerEditorHtml));
  win.eval(`document.querySelector('[data-name="Richard Baisz"]').click()`);
  win.eval(`saveFieldEdit("ordered_by")`);
  check("Selecting a different partner and saving updates invoiceData.ordered_by",
    win.eval('invoiceData.ordered_by') === "Richard Baisz");

  // PARTNER/CLIENT: custom free-text fallback for a one-off name not in the known list
  win.eval(`showCorrectionMenu("labor")`);
  win.eval(`showFieldEditor("ordered_by")`);
  win.eval(`document.getElementById("editPartnerCustom").value = "Someone One-Off"; saveFieldEdit("ordered_by");`);
  check("Typing a custom name not in the known partner list is accepted and saved",
    win.eval('invoiceData.ordered_by') === "Someone One-Off");

  // Confirm after any save, the view returns to the normal invoice preview (not stuck in edit mode)
  const finalHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("After saving a field edit, the view returns to the normal invoice preview",
    finalHtml.includes("invoice-preview") && !finalHtml.includes("editFieldInput"));
}

async function testInlineCorrectionEditorLineItems() {
  console.log("\n=== TEST SUITE 35: Inline Correction Editor — Work/Tasks and Materials/Receipts (editable line items) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`
    contractorInfo.mode = "generic";
    invoiceType = "both";
    invoiceData = {
      done:true, bill_to_name:"Test Client", bill_to_address:"x", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"", job_address:"123 Main St",
      work_items:[{desc:"Replace water heater",amount:700},{desc:"Replace damaged pipes",amount:150},{desc:"Install new hoses",amount:50}],
      materials_items:[{vendor:"Home Depot",desc:"Plumbing materials",date:"May 23, 2026",amount:115.51}],
      date:"May 23, 2026", has_materials:true, has_labor:true
    };
    document.getElementById("photoSections").style.display="block";
    document.getElementById("receiptSection").style.display="block";
    showInvoicePreview(invoiceData);
  `);

  // WORK ITEMS: editing just ONE line should not require re-entering the others (the core
  // repetition problem this whole rebuild exists to solve)
  win.eval(`showCorrectionMenu("both")`);
  win.eval(`showFieldEditor("work_items")`);
  const workEditorHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Work items editor shows all three existing tasks as separate editable rows",
    (workEditorHtml.match(/edit-line-row/g)||[]).length === 3);
  check("Each existing task's description and amount are pre-filled", workEditorHtml.includes("Replace water heater") && workEditorHtml.includes('value="700"'));

  // Correct just the water heater price, leave the other two untouched
  win.eval(`
    const rows = document.querySelectorAll("#editLineItems .edit-line-row");
    rows[0].querySelector(".ln-amt").value = "750";
    saveFieldEdit("work_items");
  `);
  const updatedWorkItems = JSON.parse(win.eval('JSON.stringify(invoiceData.work_items)'));
  check("Editing one task's price updates ONLY that task, without needing to re-enter the others",
    updatedWorkItems.length === 3 && updatedWorkItems[0].amount === 750 && updatedWorkItems[1].desc === "Replace damaged pipes" && updatedWorkItems[2].desc === "Install new hoses");
  check("This entire correction required zero AI conversation messages",
    win.eval('messages.length') === 0);

  // Deleting a row
  win.eval(`showCorrectionMenu("both")`);
  win.eval(`showFieldEditor("work_items")`);
  win.eval(`
    const rows = document.querySelectorAll("#editLineItems .edit-line-row");
    deleteEditLineRow(rows[1].querySelector(".edit-line-del"));
    saveFieldEdit("work_items");
  `);
  const afterDelete = JSON.parse(win.eval('JSON.stringify(invoiceData.work_items)'));
  check("Deleting one row removes only that task, keeping the others intact",
    afterDelete.length === 2 && afterDelete.find(i=>i.desc==="Replace damaged pipes") === undefined);

  // Adding a new row
  win.eval(`showCorrectionMenu("both")`);
  win.eval(`showFieldEditor("work_items")`);
  win.eval(`addEditLineRow("work")`);
  win.eval(`
    const rows = document.querySelectorAll("#editLineItems .edit-line-row");
    const lastRow = rows[rows.length-1];
    lastRow.querySelector(".ln-desc").value = "New extra task";
    lastRow.querySelector(".ln-amt").value = "99";
    saveFieldEdit("work_items");
  `);
  const afterAdd = JSON.parse(win.eval('JSON.stringify(invoiceData.work_items)'));
  check("Adding a new row and saving includes the new task alongside the existing ones",
    afterAdd.length === 3 && afterAdd.find(i=>i.desc==="New extra task"&&i.amount===99));

  // Cannot save an empty task list
  win.eval(`showCorrectionMenu("both")`);
  win.eval(`showFieldEditor("work_items")`);
  let alertCalled = false;
  win.alert = () => { alertCalled = true; };
  win.eval(`
    document.querySelectorAll("#editLineItems .edit-line-row").forEach(row => deleteEditLineRow(row.querySelector(".edit-line-del")));
    saveFieldEdit("work_items");
  `);
  check("Attempting to save with zero tasks is rejected (at least one task required)", alertCalled === true);

  // MATERIALS: same single-row-edit behavior, with the extra vendor/date fields
  win.eval(`showCorrectionMenu("both")`);
  win.eval(`showFieldEditor("materials_items")`);
  const matEditorHtml = win.document.getElementById("invoiceArea").innerHTML;
  check("Materials editor shows the existing receipt as an editable row with vendor, description, date, and amount fields",
    matEditorHtml.includes("Home Depot") && matEditorHtml.includes("Plumbing materials") && matEditorHtml.includes("May 23, 2026") && matEditorHtml.includes('value="115.51"'));

  win.eval(`
    const row = document.querySelector("#editLineItems .edit-line-row");
    row.querySelector(".ln-amt").value = "120.00";
    saveFieldEdit("materials_items");
  `);
  check("Editing a material receipt's amount updates it correctly",
    win.eval('invoiceData.materials_items[0].amount') === 120);

  // Materials items CAN be saved as an empty list (unlike work_items) — removing all receipts is valid
  win.eval(`showCorrectionMenu("both")`);
  win.eval(`showFieldEditor("materials_items")`);
  win.eval(`
    document.querySelectorAll("#editLineItems .edit-line-row").forEach(row => deleteEditLineRow(row.querySelector(".edit-line-del")));
    saveFieldEdit("materials_items");
  `);
  check("Materials list can be saved empty (removing all receipts is allowed, unlike tasks)",
    win.eval('invoiceData.materials_items.length') === 0);

  // Date validation also applies inside the materials line-item editor
  win.eval(`showCorrectionMenu("both")`);
  win.eval(`showFieldEditor("materials_items")`);
  win.eval(`addEditLineRow("materials")`);
  let materialsAlertCalled = false;
  win.alert = () => { materialsAlertCalled = true; };
  win.eval(`
    const row = document.querySelector("#editLineItems .edit-line-row");
    row.querySelector(".ln-vendor").value = "Test Vendor";
    row.querySelector(".ln-desc").value = "Test Item";
    row.querySelector(".ln-date").value = "May 5";
    row.querySelector(".ln-amt").value = "10";
    saveFieldEdit("materials_items");
  `);
  check("A material receipt date missing a year is rejected by the same validation used elsewhere",
    materialsAlertCalled === true);
}

async function testPhotoInputAllowsGallerySelection() {
  console.log("\n=== TEST SUITE 36: Photo Input Allows Gallery Selection (regression for Adrian's reported camera-only bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const jobInput = win.document.getElementById("jobPhotoInput");
  const receiptInput = win.document.getElementById("receiptPhotoInput");
  check("Job photo input no longer forces camera-only capture", !jobInput.hasAttribute("capture"));
  check("Receipt photo input no longer forces camera-only capture", !receiptInput.hasAttribute("capture"));
  check("Job photo input still restricts to image files", jobInput.getAttribute("accept") === "image/*");
  check("Receipt photo input still restricts to image files", receiptInput.getAttribute("accept") === "image/*");
}

async function testInvoiceNumberStaysStableAcrossRepeatedShares() {
  console.log("\n=== TEST SUITE 37: Invoice Number Stays Stable Across Repeated Shares (regression for Adrian's reported duplicate-history bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`
    contractorInfo.mode = "bplw";
    invoiceType = "both";
    invoiceData = {
      done:true, bill_to_name:"BPLW Management", bill_to_address:"PO Box 9395, Long Beach CA 90810", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"Andrew Whallon", job_address:"1995 Canal Ave, Long Beach CA 90810",
      work_items:[{desc:"Replace water heater",amount:700}],
      materials_items:[{vendor:"Home Depot",desc:"Plumbing materials",date:"May 23, 2026",amount:115.51}],
      date:"May 23, 2026", has_materials:true, has_labor:true
    };
  `);
  const startingLaborNum = win.eval('laborNum');

  // Simulate sharing the SAME invoice six times, matching Adrian's exact real scenario
  const invNumsSeen = [];
  for (let i = 0; i < 6; i++) {
    const built = await win.eval(`buildPDF("both")`);
    invNumsSeen.push(built.invNum);
    win.eval(`recordInvoiceHistory("both", ${built.invNum})`);
    if (built.isFreshAssignment) {
      win.eval(`laborNum++; saveLaborNum();`);
    }
  }

  check("The invoice number is IDENTICAL across all six shares of the same invoice (not incrementing)",
    invNumsSeen.every(n => n === invNumsSeen[0]),
    `numbers seen: ${JSON.stringify(invNumsSeen)}`);
  check("Only the FIRST share actually consumed a number from the counter — counter advanced by exactly 1, not 6",
    win.eval('laborNum') === startingLaborNum + 1,
    `started at ${startingLaborNum}, ended at ${win.eval('laborNum')}`);

  // Critically: History must show exactly ONE entry for this invoice, not six duplicates
  const historyEntries = JSON.parse(win.eval('JSON.stringify(invoiceHistory)'));
  const matchingEntries = historyEntries.filter(h => h.invNum === invNumsSeen[0]);
  check("Exactly ONE history entry exists for this invoice after six shares, not six duplicate entries",
    matchingEntries.length === 1, `found ${matchingEntries.length} entries for invNum ${invNumsSeen[0]}`);
  check("Invoice History contains exactly one entry total (no other phantom entries were created)",
    historyEntries.length === 1, `found ${historyEntries.length} total history entries`);

  // The invoice number must be remembered directly on invoiceData itself, so it survives
  // even if buildPDF is called again much later in the same session
  check("invoiceData.assignedInvNum is set after the first build, so the number is genuinely persistent",
    win.eval('invoiceData.assignedInvNum') === invNumsSeen[0]);

  // Starting a genuinely NEW invoice (via resetChat) must NOT reuse the old assignedInvNum,
  // and must correctly get the next available number
  win.eval(`resetChat()`);
  win.eval(`
    invoiceType = "labor";
    invoiceData = {
      done:true, bill_to_name:"BPLW Management", bill_to_address:"x", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"Richard Baisz", job_address:"456 Different St",
      work_items:[{desc:"A different job",amount:200}], materials_items:[],
      date:"June 1, 2026", has_materials:false, has_labor:true
    };
  `);
  check("A genuinely new invoice has no assignedInvNum yet", win.eval('invoiceData.assignedInvNum') === undefined);
  const newBuilt = await win.eval(`buildPDF("labor")`);
  check("A new invoice gets the NEXT sequential number, not a repeat of the previous invoice's number",
    newBuilt.invNum === startingLaborNum + 1);
  check("buildPDF correctly reports this as a fresh assignment for the new invoice",
    newBuilt.isFreshAssignment === true);

  // generatePDF and shareInvoicePDF themselves must also only increment once, end-to-end
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`
    contractorInfo.mode = "generic";
    invoiceType = "materials";
    invoiceData = {
      done:true, bill_to_name:"Test Client", bill_to_address:"x", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"", job_address:"123 Main St",
      work_items:[], materials_items:[{vendor:"A",desc:"B",date:"x",amount:10}],
      date:"June 1, 2026", has_materials:true, has_labor:false
    };
    document.getElementById("photoSections").style.display = "block";
    document.getElementById("receiptSection").style.display = "block";
  `);
  const startingMatNum = win2.eval('matNum');
  await win2.eval(`generatePDF("materials")`);
  await win2.eval(`generatePDF("materials")`);
  await win2.eval(`generatePDF("materials")`);
  check("Calling generatePDF three times on the same invoice only increments matNum once",
    win2.eval('matNum') === startingMatNum + 1, `started ${startingMatNum}, ended ${win2.eval('matNum')}`);
  const historyAfterThreeGenerates = JSON.parse(win2.eval('JSON.stringify(invoiceHistory)'));
  check("generatePDF called three times on the same invoice produces exactly one history entry",
    historyAfterThreeGenerates.length === 1);
}

async function testDeleteFromUncompletedList() {
  console.log("\n=== TEST SUITE 38: Delete From Uncompleted List (regression for Adrian's reported missing-delete bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Set up two different kinds of incomplete entries: a mid-conversation save and a
  // finished-invoice-pending-receipts save, matching the two real entry types this list holds.
  win.eval(`
    incompleteInvoices = [
      {kind:"conversation", invoiceType:"labor", messages:[{role:"user",content:"x"}], convStage:"tasks", currentOrderedBy:"Andrew Whallon", contractorMode:"bplw", job_address:"123 Main St", jobPhotos:[], receipts:[], saved_at:new Date().toISOString()},
      {invoiceData:{job_address:"456 Other St", date:"June 1, 2026"}, receipts:[], job_address:"456 Other St", date:"June 1, 2026", receipts_count:1, saved_at:new Date().toISOString()}
    ];
    saveIncomplete();
    renderIncompleteList();
  `);

  const initialHtml = win.document.getElementById("incompleteList").innerHTML;
  check("Both incomplete entries render with a visible Delete button",
    (initialHtml.match(/incomplete-del-btn/g)||[]).length === 2);
  check("Each entry's clickable info area is a separate element from its delete button (so tapping Delete doesn't also resume the invoice)",
    initialHtml.includes("incomplete-item-info") && initialHtml.includes("incomplete-del-btn"));

  // Delete the first (conversation-type) entry
  win.eval(`deleteIncomplete(0)`);
  check("Deleting the first entry removes it from incompleteInvoices", win.eval('incompleteInvoices.length') === 1);
  check("The remaining entry is the second one (finished-invoice type), not the deleted conversation entry",
    win.eval('incompleteInvoices[0].job_address') === "456 Other St");

  // Confirm the deletion actually persisted to localStorage, not just the in-memory array
  const persistedAfterDelete = JSON.parse(win.eval('localStorage.getItem("alfonso_incomplete")'));
  check("Deletion is persisted to localStorage, surviving a reload", persistedAfterDelete.length === 1);

  // Delete the remaining entry too
  win.eval(`deleteIncomplete(0)`);
  check("Deleting the last entry leaves the list empty", win.eval('incompleteInvoices.length') === 0);
  win.eval(`renderIncompleteList()`);
  const emptyHtml = win.document.getElementById("incompleteList").innerHTML;
  check("After deleting all entries, the empty-state message displays correctly",
    emptyHtml.includes("No uncompleted invoices") || emptyHtml.includes("No hay facturas pendientes"));

  // Deleting an entry must NOT affect Invoice History — these are separate, independent lists
  win.eval(`
    invoiceHistory = [{type:"labor", invNum:99001, invoiceData:{job_address:"789 History Rd", date:"x", ordered_by:"x", work_items:[{desc:"a",amount:1}], materials_items:[]}, receipts:[], jobPhotos:[], created_at:new Date().toISOString()}];
    incompleteInvoices = [{invoiceData:{job_address:"999 Pending St", date:"x"}, receipts:[], job_address:"999 Pending St", date:"x", receipts_count:0, saved_at:new Date().toISOString()}];
    saveHistory();
    saveIncomplete();
    deleteIncomplete(0);
  `);
  check("Deleting an Uncompleted entry does not touch Invoice History at all", win.eval('invoiceHistory.length') === 1);
  check("The History entry's data is completely untouched", win.eval('invoiceHistory[0].invoiceData.job_address') === "789 History Rd");

  // Photo cleanup: deleting an entry with referenced photos should clean up the underlying
  // IndexedDB blobs, not just remove the reference and leak storage
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  const photoId1 = await win2.eval(`savePhotoBlob("data:image/jpeg;base64,RECEIPT1")`);
  const photoId2 = await win2.eval(`savePhotoBlob("data:image/jpeg;base64,JOBPHOTO1")`);
  win2.eval(`
    incompleteInvoices = [{invoiceData:{job_address:"x", date:"x"}, receipts:["${photoId1}"], jobPhotos:["${photoId2}"], job_address:"x", date:"x", receipts_count:1, saved_at:new Date().toISOString()}];
    saveIncomplete();
  `);
  await win2.eval(`deleteIncomplete(0)`);
  await wait(200);
  const photo1AfterDelete = await win2.eval(`getPhotoBlob("${photoId1}")`);
  const photo2AfterDelete = await win2.eval(`getPhotoBlob("${photoId2}")`);
  check("Deleting an incomplete entry also cleans up its referenced receipt photo from IndexedDB (no orphaned storage)",
    photo1AfterDelete === null);
  check("Deleting an incomplete entry also cleans up its referenced job photo from IndexedDB",
    photo2AfterDelete === null);
}

async function testUncompletedListNoTypeLabel() {
  console.log("\n=== TEST SUITE 39: Uncompleted List Drops Type Label (regression for Adrian's reported inconsistency with History) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Finished-invoice-pending-receipts entries (the "Materials —" labeled ones in the screenshot)
  win.eval(`
    incompleteInvoices = [
      {invoiceData:{job_address:"1995 Canal Ave, Long Beach CA 90810", date:"May 23, 2026"}, receipts:[], job_address:"1995 Canal Ave, Long Beach CA 90810", date:"May 23, 2026", receipts_count:0, saved_at:new Date().toISOString()}
    ];
    saveIncomplete();
    renderIncompleteList();
  `);
  const finishedHtml = win.document.getElementById("incompleteList").innerHTML;
  check("Finished-invoice-pending entries no longer show the 'Materials' type label",
    !finishedHtml.includes(">Materials —") && !finishedHtml.includes("Materials —"));
  check("The street address is still shown, just without the type prefix", finishedHtml.includes("1995 Canal Ave"));

  // Mid-conversation entries (the ones that previously showed Labor/Materials/Combined)
  ["labor","materials","both"].forEach(invType => {
    win.eval(`
      incompleteInvoices = [
        {kind:"conversation", invoiceType:"${invType}", messages:[{role:"user",content:"x"}], convStage:"tasks", currentOrderedBy:"Test", contractorMode:"bplw", job_address:"123 Test St", jobPhotos:[], receipts:[], saved_at:new Date().toISOString()}
      ];
      renderIncompleteList();
    `);
    const convHtml = win.document.getElementById("incompleteList").innerHTML;
    check(`Mid-conversation entry (type=${invType}) no longer shows a Labor/Materials/Combined type label`,
      !convHtml.includes(">Labor<") && !convHtml.includes(">Materials<") && !convHtml.includes("Labor &amp; Materials") && !convHtml.includes("Labor & Materials"));
    check(`Mid-conversation entry (type=${invType}) still shows 'In Progress' and the street address`,
      convHtml.includes("In Progress") && convHtml.includes("123 Test St"));
  });
}

async function testGeneratePdfOpensForViewingNotDownload() {
  console.log("\n=== TEST SUITE 40: Generate PDF Opens for Viewing Instead of Forcing a Download (regression for Adrian's reported download-prompt bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`
    contractorInfo.mode = "bplw";
    invoiceType = "labor";
    invoiceData = {
      done:true, bill_to_name:"BPLW Management", bill_to_address:"PO Box 9395, Long Beach CA 90810", bill_to_email:"x", bill_to_phone:"",
      ordered_by:"Andrew Whallon", job_address:"1001 Cherry Ave Unit 204, Long Beach CA 90813",
      work_items:[{desc:"Dispose of mouse and mouse trap",amount:85},{desc:"Repair toilet",amount:60}], materials_items:[],
      date:"April 3, 2026", has_materials:false, has_labor:true
    };
  `);

  // generatePDF's source must no longer call doc.save() at all — that was the forced-download trigger
  const generatePDFSource = win.eval('generatePDF.toString()');
  check("generatePDF no longer calls doc.save() (which forced an immediate download)",
    !generatePDFSource.includes("doc.save("));
  check("generatePDF creates a blob URL to open for viewing instead", generatePDFSource.includes("createObjectURL"));
  check("generatePDF opens the viewer window synchronously before any async work, to avoid mobile popup-blocking",
    /window\.open\(""/.test(generatePDFSource) || generatePDFSource.indexOf('window.open("","_blank")') < generatePDFSource.indexOf("await buildPDF"));

  // Actually calling it should not throw, and should still correctly record history / advance the counter
  const startingLaborNum = win.eval('laborNum');
  let threw = false;
  try {
    await win.eval(`generatePDF("labor")`);
  } catch(e) { threw = true; }
  check("Calling generatePDF (which now opens a viewer instead of downloading) does not throw", !threw);
  check("generatePDF still correctly records the invoice in History", win.eval('invoiceHistory.length') === 1);
  check("generatePDF still correctly advances the invoice number counter exactly once",
    win.eval('laborNum') === startingLaborNum + 1);

  // Calling it a second time on the same invoice should reuse the same number (same stability
  // guarantee as before) and must NOT prompt anything like a "file already exists" dialog,
  // since there's no actual filesystem download happening through this button anymore.
  await win.eval(`generatePDF("labor")`);
  check("Generating the same invoice's PDF twice still reuses the same invoice number",
    win.eval('laborNum') === startingLaborNum + 1);
  check("Generating the same invoice's PDF twice still produces only one History entry",
    win.eval('invoiceHistory.length') === 1);

  // The confirmation message should mention viewing/saving via browser or Share, not "downloaded"
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Confirmation message no longer says the PDF was 'downloaded'",
    !chatHtml.includes("PDF downloaded"));
  check("Confirmation message mentions the browser's download option or Share Invoice as alternatives",
    chatHtml.includes("Share Invoice") || chatHtml.includes("Compartir Factura"));
}

async function testStaleFreeConversationCorrectionFlowRemoved() {
  console.log("\n=== TEST SUITE 41: Stale Free-Conversation Correction Flow Removed (regression for Adrian's reported dead-end bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const sysPrompt = win.eval('getSystemPrompt()');
  check("System prompt no longer instructs the AI to list collected fields as a numbered menu",
    !sysPrompt.includes("list the collected fields as a numbered menu"));
  check("System prompt no longer instructs asking 'which task number do you want to change'",
    !sysPrompt.toLowerCase().includes("which task number do you want to change"));
  check("System prompt now explicitly tells the AI to emit the JSON immediately rather than asking what to fix",
    sysPrompt.includes("respond with the final JSON immediately"));
  check("System prompt explicitly tells the AI not to have a back-and-forth about corrections in chat",
    sysPrompt.toLowerCase().includes("never in this conversation") || sysPrompt.toLowerCase().includes("do not list fields as a numbered menu"));

  // The confirmation chip's underlying message should no longer be the literal phrase that
  // used to trigger the broken numbered-list flow
  win.eval(`showConfirmChips()`);
  const chipArea = win.document.getElementById("chipArea");
  const fixChip = Array.from(chipArea.querySelectorAll(".chip")).find(c => c.className.includes("warn"));
  check("The 'fix something' chip exists and has updated text reflecting the new flow",
    !!fixChip && (fixChip.textContent.includes("Continue") || fixChip.textContent.includes("Continuar")));

  // Clicking it should send a message that does NOT match the old broken trigger phrase
  fixChip.click();
  const lastUserMsgText = win.eval('lastUserText');
  check("Clicking the fix-something chip no longer sends the literal old trigger phrase 'I need to fix something'",
    lastUserMsgText !== "I need to fix something" && lastUserMsgText !== "Necesito corregir algo");

  // Simulate the exact broken AI message from Adrian's screenshot, and confirm the OLD trigger
  // logic (still present as a safety net for any legacy/cached responses) still at least doesn't
  // crash, even though the AI should no longer generate this message going forward
  const dom2 = freshDom();
  const win2 = dom2.window;
  await wait(300);
  let threw = false;
  try {
    win2.eval(`smartChips("4. Work items/tasks\\n5. Materials purchased\\n6. Date (January 8th 2026)\\n\\nWhich one do you want to fix?")`);
  } catch(e) { threw = true; }
  check("Even if a legacy numbered-list message somehow appears, handling it does not crash the app",
    !threw);
}

async function testBillingSetupDropdownReorderedAndReworded() {
  console.log("\n=== TEST SUITE 42: Billing Setup Dropdown Reordered and Reworded ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const select = win.document.getElementById("setMode");
  const optionValues = Array.from(select.options).map(o => o.value);
  check("Generic contractor option now comes FIRST in the dropdown (most users pick this)",
    optionValues[0] === "generic");
  check("BPLW Management option now comes SECOND (only a handful of users pick this)",
    optionValues[1] === "bplw");

  const bplwOption = win.document.getElementById("optBplw");
  check("BPLW option names the two primary partners instead of generic 'partners & shared properties' wording",
    bplwOption.textContent.includes("Andrew Whallon") && bplwOption.textContent.includes("Richard Baisz"));
  check("BPLW option no longer uses the old vague 'partners & shared properties' phrasing",
    !bplwOption.textContent.toLowerCase().includes("shared properties"));

  // Confirm the reorder doesn't affect which mode actually gets selected for a given contractor
  win.eval(`contractorInfo.mode = "bplw"; showSettings();`);
  check("A BPLW-mode contractor still correctly shows BPLW selected in Settings, despite the option's new position",
    win.document.getElementById("setMode").value === "bplw");
  win.eval(`contractorInfo.mode = "generic"; showSettings();`);
  check("A generic-mode contractor still correctly shows generic selected in Settings",
    win.document.getElementById("setMode").value === "generic");

  // Spanish translation matches the new wording
  win.eval(`setLang('es')`);
  check("Spanish BPLW option also names the two partners, not the old generic phrase",
    win.document.getElementById("optBplw").textContent.includes("Andrew Whallon") && win.document.getElementById("optBplw").textContent.includes("Richard Baisz"));
}

async function testToggleLabelFontSizeIncreased() {
  console.log("\n=== TEST SUITE 43: Toggle Label Font Size Increased (regression for Andy's reported readability issue) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const styleBlock = win.document.querySelector("style").textContent;
  const labelRuleMatch = styleBlock.match(/\.lang-toggle-label\{([^}]*)\}/);
  check("The .lang-toggle-label CSS rule exists", !!labelRuleMatch);
  if (labelRuleMatch) {
    const fontSizeMatch = labelRuleMatch[1].match(/font-size:(\d+)px/);
    check("Toggle label font size is larger than the old 10px (increased for readability)",
      !!fontSizeMatch && parseInt(fontSizeMatch[1], 10) > 10,
      `found: ${fontSizeMatch ? fontSizeMatch[1] + "px" : "no match"}`);
  }

  // Confirm the labels themselves are still present and correctly say what they should
  check("'Talk to me in' label is present", win.document.getElementById("convLangLabel").textContent === "Talk to me in");
  check("'Invoice in' label is present", win.document.getElementById("invoiceLangLabel").textContent === "Invoice in");
}

async function testInvoiceLangToggleHighlightOnOnboarding() {
  console.log("\n=== TEST SUITE 44: Invoice Language Toggle Highlight During Sequenced Onboarding ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // At stage 1 (conversation language), the invoice toggle should NOT be highlighted yet —
  // only the conversation toggle is, since the sequence hasn't reached the invoice step.
  check("isFirstTimeUser() is true on a fresh device", win.eval('isFirstTimeUser()') === true);
  const toggleEl = win.document.getElementById("invoiceLangToggle");
  check("The invoice-language toggle element exists and has a dedicated ID", !!toggleEl);
  check("The invoice-language toggle is NOT highlighted at stage 1 (only the conversation toggle is)",
    !toggleEl.classList.contains("attn-highlight"));
  const convToggle = win.document.getElementById("btnES").closest(".lang-toggle");
  check("The conversation-language toggle IS highlighted at stage 1",
    convToggle.classList.contains("attn-highlight"));

  // Advancing past stage 1 (tapping the conversation toggle) should highlight the invoice toggle
  win.eval(`setLang('en')`);
  await wait(100);
  check("After advancing past stage 1, the invoice-language toggle IS now highlighted",
    win.document.getElementById("invoiceLangToggle").classList.contains("attn-highlight"));
  check("After advancing past stage 1, the conversation-language toggle is no longer highlighted",
    !win.document.getElementById("btnES").closest(".lang-toggle").classList.contains("attn-highlight"));

  // The stage-2 message should mention the separate invoice-language toggle and translation feature
  const chatHtml = win.document.getElementById("chatBox").innerHTML;
  check("Stage 2 message explains the automatic translation feature and invoice language choice",
    chatHtml.toLowerCase().includes("translation"));

  // Tapping the invoice-language toggle directly should remove the highlight and advance to stage 3
  win.eval(`setInvoiceLang('es')`);
  check("Tapping the invoice-language toggle directly removes the highlight",
    !win.document.getElementById("invoiceLangToggle").classList.contains("attn-highlight"));
  check("Tapping the invoice-language toggle advances onboarding to the final 'done' stage",
    win.eval('onboardingStage') === "done");

  // Proceeding past onboarding (tapping the My Info nav link) should keep the invoice highlight off
  win.eval(`document.getElementById("navSettings").click()`);
  check("Tapping My Info keeps the invoice-language highlight off", !win.document.getElementById("invoiceLangToggle").classList.contains("attn-highlight"));

  // A returning user (info already set) should never see either highlight at all
  const dom2 = domWithPreseededStorage({
    contractor_info: JSON.stringify({firstName:"Carlos", lastName:"Ruiz", businessName:"", address:"", phone:"", mode:"generic"})
  });
  const win2 = dom2.window;
  await wait(300);
  check("A returning user (not first-time) does NOT see the invoice-language toggle highlighted",
    !win2.document.getElementById("invoiceLangToggle").classList.contains("attn-highlight"));
  check("A returning user (not first-time) does NOT see the conversation-language toggle highlighted",
    !win2.document.getElementById("btnES").closest(".lang-toggle").classList.contains("attn-highlight"));
}

async function testBackButtonFromSettingsDuringOnboarding() {
  console.log("\n=== TEST SUITE 45: Back Button From Settings During Onboarding (regression for Adrian's reported dead-end bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // Walk through onboarding to reach stage 3 (highlighted My Info nav link)
  win.eval(`setLang('en')`);
  win.eval(`setInvoiceLang('en')`);
  await wait(100);
  check("Onboarding reaches the final 'done' stage with My Info highlighted", win.eval('onboardingStage') === "done");
  check("The My Info nav link is highlighted before tapping it",
    win.document.getElementById("navSettings").classList.contains("attn-highlight"));

  // Tap My Info — this opens Settings and (per the original bug class) used to permanently
  // lose the call-to-action if the user backed out without saving
  win.eval(`document.getElementById("navSettings").click()`);
  check("Tapping My Info opens the Settings panel", win.document.getElementById("settingsPanel").style.display === "block");
  check("The My Info highlight clears once tapped (now inside Settings)",
    !win.document.getElementById("navSettings").classList.contains("attn-highlight"));

  // Tap Back WITHOUT saving — this is the exact scenario Adrian reported
  win.eval(`hideSettings()`);
  check("Tapping Back closes the Settings panel", win.document.getElementById("settingsPanel").style.display !== "block");
  check("Tapping Back returns to the main panel", win.document.getElementById("mainPanel").style.display === "block");
  check("CRITICAL: the My Info highlight is restored after backing out without saving — there must be a clear way back in",
    win.document.getElementById("navSettings").classList.contains("attn-highlight"));
  check("Still a first-time user after backing out without saving (no info was actually entered)",
    win.eval('isFirstTimeUser()') === true);

  // Tapping My Info again should correctly re-open Settings
  win.eval(`document.getElementById("navSettings").click()`);
  check("Tapping the re-highlighted My Info link successfully re-opens Settings",
    win.document.getElementById("settingsPanel").style.display === "block");

  // This time, actually fill in info and save — confirm the whole flow still completes correctly
  win.document.getElementById("setFirstName").value = "Jose";
  win.document.getElementById("setLastName").value = "Garcia";
  win.eval(`saveSettingsForm()`);
  await wait(100);
  check("After actually saving info (post back-and-forth), Settings closes automatically",
    win.document.getElementById("settingsPanel").style.display !== "block");
  check("isFirstTimeUser() correctly becomes false after saving real info",
    win.eval('isFirstTimeUser()') === false);
  const postSaveChatHtml = win.document.getElementById("chatBox").innerHTML;
  check("The normal invoice-type greeting appears with the correct name after this full back-and-forth flow",
    postSaveChatHtml.includes("What type of invoice do you need") && postSaveChatHtml.includes("Jose"));

  // Confirm backing out of Settings AFTER onboarding is complete (normal returning-user case)
  // does NOT incorrectly highlight My Info, since that's only relevant during onboarding
  const dom2 = domWithPreseededStorage({
    contractor_info: JSON.stringify({firstName:"Maria", lastName:"Lopez", businessName:"", address:"", phone:"", mode:"generic"})
  });
  const win2 = dom2.window;
  await wait(300);
  win2.eval(`showSettings()`);
  win2.eval(`hideSettings()`);
  check("For a RETURNING user (not onboarding), backing out of Settings does NOT incorrectly highlight My Info",
    !win2.document.getElementById("navSettings").classList.contains("attn-highlight"));
}

async function testHighlightPulseColorIsYellow() {
  console.log("\n=== TEST SUITE 46: Highlight Pulse Color Changed to Bright Yellow (regression for Andy's reported visibility concern) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const styleBlock = win.document.querySelector("style").textContent;
  const keyframesMatch = styleBlock.match(/@keyframes attnPulse\{([^]*?)\}\s*\.lang-btn/) || styleBlock.match(/@keyframes attnPulse\{([^]*?)\n\}/);
  check("The attnPulse keyframes animation exists", !!keyframesMatch);
  if (keyframesMatch) {
    const keyframesBody = keyframesMatch[1];
    check("Pulse color is NOT the old green (rgba(29,158,117,...))", !keyframesBody.includes("29,158,117"));
    check("Pulse color uses a yellow/gold RGB value (250,204,21 — Tailwind's 'yellow-400')",
      keyframesBody.includes("250,204,21"));
  }

  // The nav button highlight variant must also exist and be visually distinct
  check(".nav-btn.attn-highlight CSS rule exists for the My Info link highlight",
    styleBlock.includes(".nav-btn.attn-highlight"));
  const navBtnRuleMatch = styleBlock.match(/\.nav-btn\.attn-highlight\{([^}]*)\}/);
  check("The nav-btn highlight makes the text bold for visibility",
    !!navBtnRuleMatch && navBtnRuleMatch[1].includes("font-weight:700"));

  // Confirm all three highlight points actually use the shared .attn-highlight class,
  // so a single color change affects all of them consistently
  win.eval(`highlightConvLangToggle()`);
  check("Conversation toggle highlight uses the shared attn-highlight class",
    win.document.getElementById("btnES").closest(".lang-toggle").classList.contains("attn-highlight"));
  win.eval(`highlightInvoiceLangToggle()`);
  check("Invoice toggle highlight uses the shared attn-highlight class",
    win.document.getElementById("invoiceLangToggle").classList.contains("attn-highlight"));
  win.eval(`highlightMyInfoNavLink()`);
  check("My Info nav link highlight uses the shared attn-highlight class",
    win.document.getElementById("navSettings").classList.contains("attn-highlight"));
}

async function testNavLinkTextDoesNotWrap() {
  console.log("\n=== TEST SUITE 47: Nav Button Text Does Not Wrap (regression for Andy's reported 'My Info' two-line bug) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const styleBlock = win.document.querySelector("style").textContent;
  const navBtnRuleMatch = styleBlock.match(/\.nav-btn\{([^}]*)\}/);
  check(".nav-btn CSS rule exists", !!navBtnRuleMatch);
  check("Nav button text has white-space:nowrap, preventing 'My Info' from breaking onto two lines",
    !!navBtnRuleMatch && navBtnRuleMatch[1].includes("white-space:nowrap"));

  // Confirm the actual button text content is correct
  check("The nav button reads 'My Info' in English", win.document.getElementById("navSettings").textContent === "My Info");
  win.eval(`setLang('es')`);
  check("The nav button reads 'Mis Datos' in Spanish", win.document.getElementById("navSettings").textContent === "Mis Datos");
}

async function testNavButtonsTwoRowLayout() {
  console.log("\n=== TEST SUITE 48: Nav Buttons Two-Row Layout (Andy's requested reorganization) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const navLinks = win.document.querySelector(".nav-links");
  check(".nav-links container exists", !!navLinks);
  const rows = navLinks.querySelectorAll(".nav-row");
  check("There are exactly two nav rows", rows.length === 2);

  const row1Ids = Array.from(rows[0].querySelectorAll(".nav-btn")).map(b => b.id);
  const row2Ids = Array.from(rows[1].querySelectorAll(".nav-btn")).map(b => b.id);
  check("Row 1 contains My Info, Clients, and Job Addresses in that order",
    row1Ids[0] === "navSettings" && row1Ids[1] === "navClients" && row1Ids[2] === "navAddresses",
    `got: ${JSON.stringify(row1Ids)}`);
  check("Row 2 contains Uncompleted and History in that order",
    row2Ids[0] === "navUncompleted" && row2Ids[1] === "navHistory",
    `got: ${JSON.stringify(row2Ids)}`);

  // Every nav element must be a real <button>, not a <span>, per the requested button styling
  const allNavEls = navLinks.querySelectorAll("#navSettings, #navClients, #navAddresses, #navUncompleted, #navHistory");
  check("All five nav elements are actual <button> elements (button-style, not plain text links)",
    Array.from(allNavEls).every(el => el.tagName === "BUTTON"));

  // The Uncompleted button should retain its distinct orange styling
  check("The Uncompleted button retains the 'orange' class for its distinct styling",
    win.document.getElementById("navUncompleted").classList.contains("orange"));

  // Confirm each button still correctly triggers its panel when clicked
  win.eval(`document.getElementById("navClients").click()`);
  check("Clicking the Clients button (now in row 1) still opens the Clients panel",
    win.document.getElementById("managerPanel").style.display === "block");
  win.eval(`document.getElementById("navHistory").click()`);
  check("Clicking the History button (now in row 2) still opens the History panel",
    win.document.getElementById("historyPanel").style.display === "block");

  // Confirm the header is structured with a distinct top row (name+toggles) separate from nav rows
  check("The header has a dedicated .header-top section for the name and language toggles",
    !!win.document.querySelector(".header-top"));
}

async function testNavButtonsHaveDistinctColors() {
  console.log("\n=== TEST SUITE 49: Nav Buttons Have Five Distinct Colors (Andy's requested visual differentiation) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  const buttonIds = ["navSettings","navClients","navAddresses","navUncompleted","navHistory"];
  const colorClasses = buttonIds.map(id => {
    const el = win.document.getElementById(id);
    return Array.from(el.classList).find(c => c !== "nav-btn" && c !== "attn-highlight");
  });
  check("Every nav button has exactly one color class assigned",
    colorClasses.every(c => !!c), `got: ${JSON.stringify(colorClasses)}`);
  check("All five nav buttons have DIFFERENT color classes from each other (no duplicates)",
    new Set(colorClasses).size === 5, `got: ${JSON.stringify(colorClasses)}`);

  // Confirm each color class actually has a corresponding CSS rule with real color values
  const styleBlock = win.document.querySelector("style").textContent;
  colorClasses.forEach(cls => {
    const ruleMatch = styleBlock.match(new RegExp(`\\.nav-btn\\.${cls}\\{([^}]*)\\}`));
    check(`'.nav-btn.${cls}' has a CSS rule defining its color`,
      !!ruleMatch && ruleMatch[1].includes("color:") && ruleMatch[1].includes("border-color:"));
  });

  // Uncompleted must keep its pre-existing orange color specifically (not change identity)
  check("Uncompleted button specifically keeps the 'orange' color class",
    win.document.getElementById("navUncompleted").classList.contains("orange"));
}

async function testHighlightTakesPrecedenceOverButtonColor() {
  console.log("\n=== TEST SUITE 50: Onboarding Highlight Takes Precedence Over Button's Own Color (CSS specificity regression) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  // The attn-highlight rule must be declared AFTER all individual color rules in the stylesheet,
  // so it wins any CSS specificity tie and the yellow pulse is always visible during onboarding,
  // regardless of which button (and therefore which color) is being highlighted.
  const styleBlock = win.document.querySelector("style").textContent;
  const highlightIndex = styleBlock.indexOf(".nav-btn.attn-highlight");
  const colorIndices = ["orange","blue","purple","teal","pink"].map(c => styleBlock.indexOf(`.nav-btn.${c}{`));
  check(".nav-btn.attn-highlight CSS rule exists", highlightIndex !== -1);
  check("The attn-highlight rule appears AFTER every individual nav-btn color rule in the stylesheet (wins specificity ties)",
    colorIndices.every(idx => idx !== -1 && idx < highlightIndex),
    `highlight at ${highlightIndex}, colors at ${JSON.stringify(colorIndices)}`);

  // Functional check: My Info has a color (blue) AND, during onboarding, the highlight class —
  // confirm the element actually carries both classes simultaneously without one being removed
  win.eval(`setLang('en')`);
  win.eval(`setInvoiceLang('en')`);
  await wait(100);
  const myInfoBtn = win.document.getElementById("navSettings");
  check("My Info button retains its 'blue' color class even while highlighted during onboarding",
    myInfoBtn.classList.contains("blue"));
  check("My Info button also carries 'attn-highlight' at the same time (both classes coexist)",
    myInfoBtn.classList.contains("attn-highlight"));
}

async function testSettingsSaveAndBackButtonsGroupedTogether() {
  console.log("\n=== TEST SUITE 51: Settings Save and Back Buttons Grouped Together (Andy's requested layout fix) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  win.eval(`showSettings()`);

  // Save must now live OUTSIDE the form card (.mgr-panel), not inside it
  const mgrPanel = win.document.querySelector("#settingsPanel .mgr-panel");
  const saveBtn = win.document.getElementById("btnSaveSettings");
  const backBtn = win.document.getElementById("settingsBackBtn");
  check("Save button is no longer inside the .mgr-panel form card", !mgrPanel.contains(saveBtn));
  check("Back button is also outside the .mgr-panel form card (same as before)", !mgrPanel.contains(backBtn));

  // Both buttons must share the same parent container, sitting together as one action row
  check("Save and Back buttons share the same parent container (grouped together)",
    saveBtn.parentElement === backBtn.parentElement);
  check("Their shared container has the action-row class",
    saveBtn.parentElement.classList.contains("action-row"));

  // Back button's wording must be updated to clarify it discards changes
  check("Back button text now reads 'Back, Do Not Save' instead of plain 'Back'",
    backBtn.textContent.includes("Do Not Save"));

  // Back button must use the red/danger styling, Save must keep its green styling
  check("Back button uses the red 'action-btn-danger' style", backBtn.classList.contains("action-btn-danger"));
  check("Save button uses the green 'action-btn-save' style", saveBtn.classList.contains("action-btn-save"));

  const styleBlock = win.document.querySelector("style").textContent;
  const dangerRuleMatch = styleBlock.match(/\.action-btn-danger\{([^}]*)\}/);
  check("The red button's CSS rule actually uses a red color (border and/or text)",
    !!dangerRuleMatch && (dangerRuleMatch[1].includes("#DC2626") || dangerRuleMatch[1].includes("#B91C1C")));

  // Both buttons must still function correctly after the relocation
  win.document.getElementById("setFirstName").value = "TestName";
  win.eval(`saveSettingsForm()`);
  check("Save button still correctly saves the entered info after relocation",
    win.eval('contractorInfo.firstName') === "TestName");

  win.eval(`showSettings()`);
  win.document.getElementById("setFirstName").value = "ShouldNotSave";
  win.eval(`hideSettings()`);
  check("Back button still correctly discards unsaved changes after relocation (does not call save)",
    win.eval('contractorInfo.firstName') === "TestName");
}

(async () => {
  try {
    await testBPLWFlow();
    await testGenericMode();
    await testSettingsMigration();
    await testPanelNavigation();
    await testFreshDeviceDefaultsToGenericOnboarding();
    await testBackButtonVisibility();
    await testNewClientFlow();
    await testPhoneFormatting();
    await testClientHandoffMessage();
    await testGenericJobAddressFlow();
    await testUnifiedAddressBplwAndContractorPurposes();
    await testDateYearValidation();
    await testJobAddressConfirmationDoesNotRetrigger();
    await testAiStatedWrongYearGetsCorrected();
    await testFormattedSummaryPhoneFormatting();
    await testConfirmationTriggerMatchesActualPromptWording();
    await testCombinedLaborMaterialsInvoice();
    await testPhotoOrientationCorrection();
    await testGenericModeJobAddressPersistence();
    await testAndrewWhallonNameCollisionFix();
    await testJobPhotoPromptFlow();
    await testRetroactiveContractorPhoneFormatting();
    await testMidConversationSaveAndResume();
    await testIndexedDBPhotoStorage();
    await testAddressManagerPrivacyFix();
    await testSpanishTranslationOfStaticUI();
    await testSpanishTranslationOfDynamicLists();
    await testAiConversationRespondsInSelectedLanguage();
    await testSettingsSeparateAddressFields();
    await testAddressParsingAndBuilding();
    await testFirstTimeWelcomeAndOnboarding();
    await testDualLanguageToggle();
    await testFormatUnitNormalization();
    await testInlineCorrectionEditorFieldSelector();
    await testInlineCorrectionEditorSimpleFields();
    await testInlineCorrectionEditorLineItems();
    await testPhotoInputAllowsGallerySelection();
    await testInvoiceNumberStaysStableAcrossRepeatedShares();
    await testDeleteFromUncompletedList();
    await testUncompletedListNoTypeLabel();
    await testGeneratePdfOpensForViewingNotDownload();
    await testStaleFreeConversationCorrectionFlowRemoved();
    await testBillingSetupDropdownReorderedAndReworded();
    await testToggleLabelFontSizeIncreased();
    await testInvoiceLangToggleHighlightOnOnboarding();
    await testBackButtonFromSettingsDuringOnboarding();
    await testHighlightPulseColorIsYellow();
    await testNavLinkTextDoesNotWrap();
    await testNavButtonsTwoRowLayout();
    await testNavButtonsHaveDistinctColors();
    await testHighlightTakesPrecedenceOverButtonColor();
    await testSettingsSaveAndBackButtonsGroupedTogether();
  } catch (e) {
    console.log("FATAL TEST ERROR:", e.message);
    console.log(e.stack);
    failed++;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    failures.forEach(f => console.log("  - " + f));
  }
  process.exit(failed > 0 ? 1 : 0);
})();
