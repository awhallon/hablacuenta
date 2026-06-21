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

  const dom = new JSDOM(pageHtml, {
    runScripts: "dangerously",
    resources: "usable",
    url: "https://hablacuenta.com/",
    beforeParse(window) {
      window.jspdf = { jsPDF: MockJsPDF };
    }
  });
  // Helper: access let/const top-level variables, which aren't exposed as window properties in jsdom's vm context
  dom.window.get = (expr) => dom.window.eval(expr);
  dom.window.set = (varName, value) => dom.window.eval(`${varName} = ${JSON.stringify(value)}`);
  dom.window.call = (expr) => dom.window.eval(expr);
  return dom;
}

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function testBPLWFlow() {
  console.log("\n=== TEST SUITE 1: BPLW Materials Invoice (Alfonso's default flow) ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("App initializes with BPLW mode by default", win.get("contractorInfo.mode") === "bplw");
  check("Greeting shows default firstName", win.document.getElementById("chatBox").innerHTML.includes("Alfonso"));

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
  win.document.getElementById("setAddress").value = "1952 Caspian Avenue, Long Beach CA";
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

async function testAlfonsoDeviceUnaffected() {
  console.log("\n=== TEST SUITE 5: Regression Check — Alfonso's Untouched Device ===");
  const dom = freshDom();
  const win = dom.window;
  await wait(300);

  check("Fresh device defaults to bplw mode", win.eval("contractorInfo.mode") === "bplw");
  check("Fresh device firstName is Alfonso", win.eval("contractorInfo.firstName") === "Alfonso");
  check("Fresh device businessName is full company name", win.eval("contractorInfo.businessName") === "Alfonso Sanchez Property Services");
  check("Fresh device greeting says Hi Alfonso", win.document.getElementById("chatBox").innerHTML.includes("Hi Alfonso!"));

  const sysPrompt = win.eval("getSystemPrompt()");
  check("System prompt mentions BPLW for default mode", sysPrompt.includes("BPLW Management"));
  check("System prompt does NOT mention generic-only client flow for BPLW mode", !sysPrompt.includes("there are no saved clients yet"));
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
  check("After name, step advances to addr_street", win.eval('newClientState.step') === "addr_street");
  check("Name was stored correctly", win.eval('newClientState.data.name') === "Maria Lopez");

  // Skip address
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

  // Test the full structured address sub-flow with a unit number
  const dom4 = freshDom();
  const win4 = dom4.window;
  await wait(300);
  win4.eval('startNewClient()');
  win4.eval(`document.getElementById("userInput").value = "Sam Rivera"; sendMsg();`);
  check("Name step advances to addr_street", win4.eval('newClientState.step') === "addr_street");

  win4.eval(`document.getElementById("userInput").value = "1234 Ocean Blvd"; sendMsg();`);
  check("Street step advances to addr_unit_yn", win4.eval('newClientState.step') === "addr_unit_yn");
  check("Street stored correctly", win4.eval('newClientState.data.addr.street') === "1234 Ocean Blvd");

  win4.eval(`document.getElementById("userInput").value = "Yes"; sendMsg();`);
  check("Saying Yes to unit moves to addr_unit_number", win4.eval('newClientState.step') === "addr_unit_number");

  win4.eval(`document.getElementById("userInput").value = "Suite 200"; sendMsg();`);
  check("Unit number step advances to addr_city", win4.eval('newClientState.step') === "addr_city");
  check("Unit stored correctly", win4.eval('newClientState.data.addr.unit') === "Suite 200");

  win4.eval(`document.getElementById("userInput").value = "Long Beach"; sendMsg();`);
  check("City step advances to addr_state", win4.eval('newClientState.step') === "addr_state");

  win4.eval(`document.getElementById("userInput").value = "CA"; sendMsg();`);
  check("State step advances to addr_zip", win4.eval('newClientState.step') === "addr_zip");

  win4.eval(`document.getElementById("userInput").value = "90802"; sendMsg();`);
  check("Zip step advances to email", win4.eval('newClientState.step') === "email");
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
  win5.eval(`document.getElementById("userInput").value = "500 Main St"; sendMsg();`);
  win5.eval(`document.getElementById("userInput").value = "No"; sendMsg();`);
  check("Saying No to unit skips straight to addr_city", win5.eval('newClientState.step') === "addr_city");
  check("Unit correctly stored as blank when answered No", win5.eval('newClientState.data.addr.unit') === "");
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // city
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // state
  win5.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`); // zip
  check("After skipping city/state/zip, reaches email step", win5.eval('newClientState.step') === "email");
  const minimalAddress = win5.eval('newClientState.data.address');
  check("Minimal address still includes street even with everything else skipped", minimalAddress.includes("500 Main St"));

  // Test that "Skip" at the very first street question bypasses the entire address sub-flow
  const dom6 = freshDom();
  const win6 = dom6.window;
  await wait(300);
  win6.eval('startNewClient()');
  win6.eval(`document.getElementById("userInput").value = "Test Person"; sendMsg();`);
  win6.eval(`document.getElementById("userInput").value = "Skip"; sendMsg();`);
  check("Skipping at addr_street jumps straight to email (bypasses whole address sub-flow)", win6.eval('newClientState.step') === "email");
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

(async () => {
  try {
    await testBPLWFlow();
    await testGenericMode();
    await testSettingsMigration();
    await testPanelNavigation();
    await testAlfonsoDeviceUnaffected();
    await testBackButtonVisibility();
    await testNewClientFlow();
    await testPhoneFormatting();
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
