import React, { useEffect, useMemo, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import {
  downloadCsv,
  formatDate,
  formatMoneyFromCents,
  normalizeError,
  parseCsvText,
  parseCurrencyToCents,
  supabase,
} from "./lib";

const QUICK_AMOUNTS = [100, 200, 300, 500];
const INITIAL_AUTH = { email: "", password: "" };
const INITIAL_CAMPER_FORM = {
  camper_id: "",
  full_name: "",
  cabin: "",
  starting_balance: "25.00",
};
const INITIAL_ITEM_FORM = {
  item_name: "",
  barcode_value: "",
  price: "",
};
const INITIAL_REPORT_FILTER = {
  type: "all",
  startDate: "",
  endDate: "",
};

function App() {
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("sign-in");
  const [authForm, setAuthForm] = useState(INITIAL_AUTH);
  const [authMessage, setAuthMessage] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [campers, setCampers] = useState([]);
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [selectedCamperId, setSelectedCamperId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [search, setSearch] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeNote, setChargeNote] = useState("Canteen purchase");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositNote, setDepositNote] = useState("Deposit added");
  const [itemBarcodeInput, setItemBarcodeInput] = useState("");
  const [camperBarcodeInput, setCamperBarcodeInput] = useState("");
  const [appMessage, setAppMessage] = useState("");
  const [loadingData, setLoadingData] = useState(false);
  const [savingAction, setSavingAction] = useState(false);

  const [showAddCamper, setShowAddCamper] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [camperForm, setCamperForm] = useState(INITIAL_CAMPER_FORM);
  const [itemForm, setItemForm] = useState(INITIAL_ITEM_FORM);

  const [reportFilter, setReportFilter] = useState(INITIAL_REPORT_FILTER);
  const camperImportRef = useRef(null);
  const itemImportRef = useRef(null);

  const [scannerTarget, setScannerTarget] = useState("camper");
  const [scannerActive, setScannerActive] = useState(false);
  const scannerRef = useRef(null);
  const scannerElementId = "barcode-scanner";

  useEffect(() => {
    let ignore = false;

    async function bootstrap() {
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();

      if (!ignore) {
        setSession(currentSession);
      }
    }

    bootstrap();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession);
    });

    return () => {
      ignore = true;
      subscription.unsubscribe();
      stopScanner();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setCampers([]);
      setItems([]);
      setTransactions([]);
      setSelectedCamperId("");
      setSelectedItemId("");
      setScannerActive(false);
      return;
    }

    refreshData();
  }, [session]);

  useEffect(() => {
    if (!selectedItemId) return;
    const item = items.find((entry) => entry.id === selectedItemId);
    if (!item) return;
    setChargeAmount((item.price_cents / 100).toFixed(2));
    setChargeNote((current) => {
      if (!current || current === "Canteen purchase") return item.item_name;
      return current;
    });
  }, [selectedItemId, items]);

  const filteredCampers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return campers;
    return campers.filter((camper) => {
      return (
        camper.camper_id.toLowerCase().includes(query) ||
        camper.full_name.toLowerCase().includes(query) ||
        (camper.cabin || "").toLowerCase().includes(query)
      );
    });
  }, [campers, search]);

  const selectedCamper =
    campers.find((camper) => camper.id === selectedCamperId) ?? null;

  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

  const filteredTransactions = useMemo(() => {
    return transactions.filter((transaction) => {
      const matchesType =
        reportFilter.type === "all" || transaction.transaction_type === reportFilter.type;

      const created = new Date(transaction.created_at);
      const matchesStart = reportFilter.startDate
        ? created >= new Date(`${reportFilter.startDate}T00:00:00`)
        : true;
      const matchesEnd = reportFilter.endDate
        ? created <= new Date(`${reportFilter.endDate}T23:59:59.999`)
        : true;

      return matchesType && matchesStart && matchesEnd;
    });
  }, [transactions, reportFilter]);

  const reportSummary = useMemo(() => {
    return filteredTransactions.reduce(
      (summary, transaction) => {
        if (transaction.transaction_type === "charge") {
          summary.chargeCount += 1;
          summary.chargeTotal += transaction.amount_cents;
        }
        if (transaction.transaction_type === "deposit") {
          summary.depositCount += 1;
          summary.depositTotal += transaction.amount_cents;
        }
        return summary;
      },
      {
        chargeCount: 0,
        chargeTotal: 0,
        depositCount: 0,
        depositTotal: 0,
      }
    );
  }, [filteredTransactions]);


  async function importCampersCsv(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setSavingAction(true);
    setAppMessage("");

    try {
      const rows = parseCsvText(await file.text());
      if (!rows.length) {
        throw new Error("The camper CSV file is empty.");
      }

      const payload = rows.map((row, index) => {
        const camperId = String(row.camper_id ?? row.camperId ?? row.id ?? "").trim();
        const fullName = String(row.full_name ?? row.fullName ?? row.name ?? "").trim();
        const cabin = String(row.cabin ?? "").trim();
        const barcodeValue = String(row.barcode_value ?? row.barcode ?? camperId).trim();
        const balanceSource = row.balance ?? row.starting_balance ?? row.startingBalance ?? "0";
        const balanceCents = parseCurrencyToCents(balanceSource);

        if (!camperId || !fullName) {
          throw new Error(`Camper CSV row ${index + 2} is missing camper_id or full_name.`);
        }

        return {
          camper_id: camperId,
          full_name: fullName,
          cabin: cabin || null,
          barcode_value: barcodeValue || camperId,
          balance_cents: balanceCents,
          is_active: true,
        };
      });

      for (const [index, entry] of payload.entries()) {
        if (!Number.isFinite(entry.balance_cents) || entry.balance_cents < 0) {
          throw new Error(`Camper CSV row ${index + 2} has an invalid balance.`);
        }
      }

      const { error } = await supabase.from("campers").upsert(payload, {
        onConflict: "camper_id",
        ignoreDuplicates: false,
      });

      if (error) throw error;

      setAppMessage(`Imported ${payload.length} campers.`);
      await refreshData();
    } catch (error) {
      setAppMessage(normalizeError(error, "Could not import campers CSV."));
    } finally {
      setSavingAction(false);
    }
  }

  async function voidTransaction(transactionId) {
    const confirmed = window.confirm(
      "Void this charge? This will add the amount back to the camper balance and keep an audit trail."
    );

    if (!confirmed) return;

    setSavingAction(true);
    setAppMessage("");

    try {
      const { data, error } = await supabase.rpc("void_charge_transaction", {
        p_transaction_id: transactionId,
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.success) {
        throw new Error(result?.message || "The transaction could not be voided.");
      }

      setAppMessage(result.message || "Transaction voided.");
      await refreshData();
    } catch (error) {
      setAppMessage(normalizeError(error, "Could not void transaction."));
    } finally {
      setSavingAction(false);
    }
  }

  async function importItemsCsv(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setSavingAction(true);
    setAppMessage("");

    try {
      const rows = parseCsvText(await file.text());
      if (!rows.length) {
        throw new Error("The store items CSV file is empty.");
      }

      const payload = rows.map((row, index) => {
        const itemName = String(row.item_name ?? row.itemName ?? row.name ?? "").trim();
        const barcodeValue = String(row.barcode_value ?? row.barcode ?? "").trim();
        const priceCents = parseCurrencyToCents(row.price ?? row.amount ?? "");

        if (!itemName || !barcodeValue) {
          throw new Error(`Store item CSV row ${index + 2} is missing item_name or barcode_value.`);
        }

        if (!Number.isFinite(priceCents) || priceCents <= 0) {
          throw new Error(`Store item CSV row ${index + 2} has an invalid price.`);
        }

        return {
          item_name: itemName,
          barcode_value: barcodeValue,
          price_cents: priceCents,
          is_active: true,
        };
      });

      const { error } = await supabase.from("store_items").upsert(payload, {
        onConflict: "barcode_value",
        ignoreDuplicates: false,
      });

      if (error) throw error;

      setAppMessage(`Imported ${payload.length} store items.`);
      await refreshData();
    } catch (error) {
      setAppMessage(normalizeError(error, "Could not import store items CSV."));
    } finally {
      setSavingAction(false);
    }
  }

  function downloadCamperTemplate() {
    downloadCsv("campers-template.csv", [
      ["camper_id", "full_name", "cabin", "barcode_value", "starting_balance"],
      ["A101", "Emma Carter", "Pine", "A101", "25.00"],
      ["A102", "Noah Bennett", "Oak", "A102", "18.50"],
    ]);
  }

  function downloadItemTemplate() {
    downloadCsv("store-items-template.csv", [
      ["item_name", "barcode_value", "price"],
      ["Candy Bar", "9001001", "1.50"],
      ["Bracelet Kit", "9001002", "4.00"],
    ]);
  }


  async function refreshData() {
    setLoadingData(true);
    setAppMessage("");

    try {
      const [
        { data: campersData, error: campersError },
        { data: itemsData, error: itemsError },
        { data: transactionsData, error: transactionsError },
      ] = await Promise.all([
        supabase
          .from("campers")
          .select("id, camper_id, full_name, cabin, balance_cents, is_active, barcode_value")
          .eq("is_active", true)
          .order("full_name", { ascending: true }),
        supabase
          .from("store_items")
          .select("id, item_name, barcode_value, price_cents, is_active")
          .eq("is_active", true)
          .order("item_name", { ascending: true }),
        supabase
          .from("transactions")
          .select("id, transaction_type, amount_cents, note, created_at, campers(full_name, camper_id), store_items(item_name, barcode_value)"
  )
          .order("created_at", { ascending: false })
          .limit(500),
      ]);

      if (campersError) throw campersError;
      if (itemsError) throw itemsError;
      if (transactionsError) throw transactionsError;

      setCampers(campersData ?? []);
      setItems(itemsData ?? []);
      setTransactions(transactionsData ?? []);

      if ((campersData ?? []).length && !selectedCamperId) {
        setSelectedCamperId(campersData[0].id);
      }
    } catch (error) {
      setAppMessage(normalizeError(error, "Failed to load camp data."));
    } finally {
      setLoadingData(false);
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthMessage("");

    try {
      if (authMode === "sign-up") {
        const { error } = await supabase.auth.signUp({
          email: authForm.email,
          password: authForm.password,
        });
        if (error) throw error;
        setAuthMessage("Account created. Sign in if you do not receive an email confirmation.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authForm.email,
          password: authForm.password,
        });
        if (error) throw error;
      }
      setAuthForm(INITIAL_AUTH);
    } catch (error) {
      setAuthMessage(normalizeError(error, "Unable to sign in."));
    } finally {
      setAuthLoading(false);
    }
  }

  async function signOut() {
    await stopScanner();
    await supabase.auth.signOut();
  }

  async function createCamper(event) {
    event.preventDefault();
    setSavingAction(true);
    setAppMessage("");

    try {
      const startingBalanceCents = parseCurrencyToCents(camperForm.starting_balance);
      if (!Number.isFinite(startingBalanceCents) || startingBalanceCents < 0) {
        throw new Error("Enter a valid starting balance.");
      }

      const payload = {
        camper_id: camperForm.camper_id.trim(),
        full_name: camperForm.full_name.trim(),
        cabin: camperForm.cabin.trim() || null,
        barcode_value: camperForm.camper_id.trim(),
        balance_cents: startingBalanceCents,
      };

      const { error } = await supabase.from("campers").insert(payload);
      if (error) throw error;

      setCamperForm(INITIAL_CAMPER_FORM);
      setShowAddCamper(false);
      setAppMessage("Camper added.");
      await refreshData();
    } catch (error) {
      setAppMessage(normalizeError(error, "Could not add camper."));
    } finally {
      setSavingAction(false);
    }
  }

  async function createItem(event) {
    event.preventDefault();
    setSavingAction(true);
    setAppMessage("");

    try {
      const priceCents = parseCurrencyToCents(itemForm.price);
      if (!Number.isFinite(priceCents) || priceCents <= 0) {
        throw new Error("Enter a valid item price.");
      }

      const payload = {
        item_name: itemForm.item_name.trim(),
        barcode_value: itemForm.barcode_value.trim(),
        price_cents: priceCents,
      };

      const { error } = await supabase.from("store_items").insert(payload);
      if (error) throw error;

      setItemForm(INITIAL_ITEM_FORM);
      setShowAddItem(false);
      setAppMessage("Store item added.");
      await refreshData();
    } catch (error) {
      setAppMessage(normalizeError(error, "Could not add store item."));
    } finally {
      setSavingAction(false);
    }
  }

  async function applyTransaction(transactionType, rawAmount, note, itemId = null) {
    if (!selectedCamper) {
      setAppMessage("Select a camper first.");
      return;
    }

    const amountCents = parseCurrencyToCents(rawAmount);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setAppMessage("Enter a valid amount greater than 0.");
      return;
    }

    setSavingAction(true);
    setAppMessage("");

    try {
      const { data, error } = await supabase.rpc("apply_camper_transaction", {
        p_camper_id: selectedCamper.id,
        p_transaction_type: transactionType,
        p_amount_cents: amountCents,
        p_note: note || null,
        p_item_id: itemId,
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.success) {
        throw new Error(result?.message || "The transaction could not be completed.");
      }

      if (transactionType === "charge") {
        setChargeAmount("");
      } else {
        setDepositAmount("");
      }

      setSelectedItemId("");
      setItemBarcodeInput("");
      setAppMessage(result.message || "Saved.");
      await refreshData();
    } catch (error) {
      setAppMessage(normalizeError(error, "Could not save transaction."));
    } finally {
      setSavingAction(false);
    }
  }

  function handleCamperBarcodeLookup(value) {
    const normalized = String(value ?? "").trim();
    setCamperBarcodeInput(normalized);
    if (!normalized) return;

    const camper = campers.find((entry) => {
      const barcode = entry.barcode_value || entry.camper_id;
      return barcode.toLowerCase() === normalized.toLowerCase();
    });

    if (!camper) {
      setAppMessage(`No camper found for barcode ${normalized}.`);
      return false;
    }

    setSelectedCamperId(camper.id);
    setSearch(camper.camper_id);
    setAppMessage(`Selected ${camper.full_name}.`);
    return true;
  }

  function handleItemBarcodeLookup(value) {
    const normalized = String(value ?? "").trim();
    setItemBarcodeInput(normalized);
    if (!normalized) return;

    const item = items.find((entry) => {
      const barcode = entry.barcode_value || "";
      return barcode.toLowerCase() === normalized.toLowerCase();
    });

    if (!item) {
      setSelectedItemId("");
      setAppMessage(`No item found for barcode ${normalized}.`);
      return false;
    }

    setSelectedItemId(item.id);
    setChargeAmount((item.price_cents / 100).toFixed(2));
    setChargeNote(item.item_name);
    setAppMessage(`Loaded item ${item.item_name}.`);
    return true;
  }

  async function startScanner() {
    setAppMessage("");

    if (scannerRef.current) {
      await stopScanner();
    }

    const scanner = new Html5Qrcode(scannerElementId);
    scannerRef.current = scanner;

    try {
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 140 } },
        async (decodedText) => {
          const matched =
            scannerTarget === "camper"
              ? handleCamperBarcodeLookup(decodedText)
              : handleItemBarcodeLookup(decodedText);

          if (matched) {
            await stopScanner();
          }
        },
        () => {}
      );
      setScannerActive(true);
    } catch (error) {
      setAppMessage(normalizeError(error, "Unable to start the camera scanner."));
      await stopScanner();
    }
  }

  async function stopScanner() {
    if (!scannerRef.current) {
      setScannerActive(false);
      return;
    }

    const scanner = scannerRef.current;
    scannerRef.current = null;

    try {
      if (scanner.isScanning) {
        await scanner.stop();
      }
      await scanner.clear();
    } catch (_error) {
    } finally {
      setScannerActive(false);
    }
  }

  function exportTransactions() {
    const rows = [
      [
        "Timestamp",
        "Type",
        "Camper ID",
        "Camper Name",
        "Amount",
        "Note",
        "Item",
        "Item Barcode",
      ],
      ...filteredTransactions.map((entry) => [
        formatDate(entry.created_at),
        entry.transaction_type,
        entry.campers?.camper_id ?? "",
        entry.campers?.full_name ?? "",
        (entry.amount_cents / 100).toFixed(2),
        entry.note ?? "",
        entry.store_items?.item_name ?? "",
        entry.store_items?.barcode_value ?? "",
      ]),
    ];

    downloadCsv("camp-transactions-report.csv", rows);
  }

  if (!session) {
    return (
      <main className="page">
        <section className="auth-card">
          <div>
            <h1>PBC Cashless System</h1>
            <p className="muted">
              Sign in for camper balances, barcode checkout, deposits, and reports.
            </p>
          </div>

          <div className="segmented">
            <button
              type="button"
              className={authMode === "sign-in" ? "active" : ""}
              onClick={() => setAuthMode("sign-in")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={authMode === "sign-up" ? "active" : ""}
              onClick={() => setAuthMode("sign-up")}
            >
              Create staff account
            </button>
          </div>

          <form className="stack" onSubmit={handleAuthSubmit}>
            <label>
              Email
              <input
                type="email"
                value={authForm.email}
                onChange={(event) =>
                  setAuthForm((current) => ({ ...current, email: event.target.value }))
                }
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={authForm.password}
                onChange={(event) =>
                  setAuthForm((current) => ({ ...current, password: event.target.value }))
                }
                required
              />
            </label>

            <button type="submit" disabled={authLoading}>
              {authLoading ? "Working..." : authMode === "sign-up" ? "Create account" : "Sign in"}
            </button>
          </form>

          {authMessage ? <div className="notice">{authMessage}</div> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="app-shell">
        <header className="topbar">
          <div>
            <h1>PBC Cashless System</h1>
            <p className="muted">
              Camper lookup, barcode charging, deposits, and transaction reports.
            </p>
          </div>
          <div className="topbar-actions">
            <button type="button" onClick={refreshData} disabled={loadingData}>
              {loadingData ? "Refreshing..." : "Refresh"}
            </button>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>

        {appMessage ? <div className="notice success">{appMessage}</div> : null}

        <div className="layout">
          <section className="panel">
            <div className="section-head">
              <div>
                <h2>Campers</h2>
                <p className="muted">Search by name, ID, cabin, or scan a camper barcode.</p>
              </div>
              <button type="button" onClick={() => setShowAddCamper((current) => !current)}>
                {showAddCamper ? "Close" : "Add camper"}
              </button>
            </div>

            {showAddCamper ? (
              <form className="card stack" onSubmit={createCamper}>
                <div className="grid-2">
                  <label>
                    Camper ID
                    <input
                      value={camperForm.camper_id}
                      onChange={(event) =>
                        setCamperForm((current) => ({ ...current, camper_id: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <label>
                    Cabin
                    <input
                      value={camperForm.cabin}
                      onChange={(event) =>
                        setCamperForm((current) => ({ ...current, cabin: event.target.value }))
                      }
                    />
                  </label>
                </div>

                <label>
                  Full name
                  <input
                    value={camperForm.full_name}
                    onChange={(event) =>
                      setCamperForm((current) => ({ ...current, full_name: event.target.value }))
                    }
                    required
                  />
                </label>

                <label>
                  Starting balance
                  <input
                    value={camperForm.starting_balance}
                    onChange={(event) =>
                      setCamperForm((current) => ({
                        ...current,
                        starting_balance: event.target.value,
                      }))
                    }
                    placeholder="25.00"
                    required
                  />
                </label>

                <button type="submit" disabled={savingAction}>
                  Save camper
                </button>
              </form>
            ) : null}


            <div className="card stack">
              <div className="section-head">
                <div>
                  <h3>Import campers</h3>
                  <p className="muted">Upload a CSV to add or update camper balances in bulk.</p>
                </div>
              </div>
              <div className="inline-form wrap">
                <button type="button" onClick={downloadCamperTemplate}>
                  Download camper CSV template
                </button>
                <button
                  type="button"
                  onClick={() => camperImportRef.current?.click()}
                  disabled={savingAction}
                >
                  Import campers CSV
                </button>
                <input
                  ref={camperImportRef}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={importCampersCsv}
                />
              </div>
              <div className="muted">
                Required columns: camper_id, full_name. Optional: cabin, barcode_value, starting_balance.
              </div>
            </div>

            <div className="search stack">
              <label>
                Search campers
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="A101, Emma, Pine"
                />
              </label>

              <div className="inline-form">
                <label className="grow">
                  Camper barcode
                  <input
                    value={camperBarcodeInput}
                    onChange={(event) => setCamperBarcodeInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleCamperBarcodeLookup(camperBarcodeInput);
                      }
                    }}
                    placeholder="Scan or type camper barcode"
                  />
                </label>
                <button type="button" onClick={() => handleCamperBarcodeLookup(camperBarcodeInput)}>
                  Find camper
                </button>
              </div>
            </div>

            <div className="table">
              <div className="thead">
                <div>ID</div>
                <div>Name</div>
                <div>Cabin</div>
                <div>Balance</div>
              </div>
              <div className="tbody">
                {filteredCampers.map((camper) => (
                  <button
                    key={camper.id}
                    type="button"
                    className={`row ${selectedCamperId === camper.id ? "selected" : ""}`}
                    onClick={() => setSelectedCamperId(camper.id)}
                  >
                    <div>{camper.camper_id}</div>
                    <div>{camper.full_name}</div>
                    <div>{camper.cabin || "—"}</div>
                    <div>{formatMoneyFromCents(camper.balance_cents)}</div>
                  </button>
                ))}
                {!filteredCampers.length ? <div className="empty">No campers found.</div> : null}
              </div>
            </div>
          </section>

          <div className="right-column">
            <section className="panel stack">
              <div className="section-head">
                <div>
                  <h2>Scanner</h2>
                  <p className="muted">Use the camera to scan camper IDs or item barcodes.</p>
                </div>
              </div>

              <div className="segmented">
                <button
                  type="button"
                  className={scannerTarget === "camper" ? "active" : ""}
                  onClick={() => setScannerTarget("camper")}
                >
                  Scan camper
                </button>
                <button
                  type="button"
                  className={scannerTarget === "item" ? "active" : ""}
                  onClick={() => setScannerTarget("item")}
                >
                  Scan item
                </button>
              </div>

              <div className="inline-form">
                <button type="button" onClick={startScanner} disabled={scannerActive}>
                  {scannerActive ? "Scanner running" : "Start camera"}
                </button>
                <button type="button" onClick={stopScanner} disabled={!scannerActive}>
                  Stop camera
                </button>
              </div>

              <div id={scannerElementId} className="scanner-box" />
            </section>

            <section className="panel stack">
              <div>
                <h2>Selected camper</h2>
                {selectedCamper ? (
                  <>
                    <div className="card">
                      <div className="label">Camper</div>
                      <div className="value">{selectedCamper.full_name}</div>
                      <div className="muted">
                        {selectedCamper.camper_id} · {selectedCamper.cabin || "No cabin"}
                      </div>
                    </div>
                    <div className="card balance-card">
                      <div className="label">Current balance</div>
                      <div className="value">
                        {formatMoneyFromCents(selectedCamper.balance_cents)}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="empty">Select a camper to continue.</div>
                )}
              </div>

              <div className="card stack">
                <div className="section-head">
                  <div>
                    <h3>Charge account</h3>
                    <p className="muted">Use quick buttons, a custom amount, or an item barcode.</p>
                  </div>
                </div>

                <div className="quick-grid">
                  {QUICK_AMOUNTS.map((amount) => (
                    <button
                      key={amount}
                      type="button"
                      onClick={() =>
                        applyTransaction("charge", (amount / 100).toFixed(2), "Quick charge")
                      }
                      disabled={savingAction}
                    >
                      Charge {formatMoneyFromCents(amount)}
                    </button>
                  ))}
                </div>

                <div className="inline-form">
                  <label className="grow">
                    Item barcode
                    <input
                      value={itemBarcodeInput}
                      onChange={(event) => setItemBarcodeInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleItemBarcodeLookup(itemBarcodeInput);
                        }
                      }}
                      placeholder="Scan or type item barcode"
                    />
                  </label>
                  <button type="button" onClick={() => handleItemBarcodeLookup(itemBarcodeInput)}>
                    Load item
                  </button>
                </div>

                {selectedItem ? (
                  <div className="notice">
                    <strong>{selectedItem.item_name}</strong> ·{" "}
                    {formatMoneyFromCents(selectedItem.price_cents)} · Barcode{" "}
                    {selectedItem.barcode_value}
                  </div>
                ) : null}

                <div className="inline-form">
                  <label className="grow">
                    Charge amount
                    <input
                      value={chargeAmount}
                      onChange={(event) => setChargeAmount(event.target.value)}
                      placeholder="3.50"
                    />
                  </label>
                  <label className="grow">
                    Note
                    <input
                      value={chargeNote}
                      onChange={(event) => setChargeNote(event.target.value)}
                    />
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    applyTransaction("charge", chargeAmount, chargeNote, selectedItem?.id ?? null)
                  }
                  disabled={savingAction}
                >
                  Save charge
                </button>
              </div>

              <div className="card stack">
                <div>
                  <h3>Add deposit</h3>
                  <p className="muted">Add more money to the camper balance during the week.</p>
                </div>

                <div className="inline-form">
                  <label className="grow">
                    Deposit amount
                    <input
                      value={depositAmount}
                      onChange={(event) => setDepositAmount(event.target.value)}
                      placeholder="20.00"
                    />
                  </label>
                  <label className="grow">
                    Note
                    <input
                      value={depositNote}
                      onChange={(event) => setDepositNote(event.target.value)}
                    />
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => applyTransaction("deposit", depositAmount, depositNote)}
                  disabled={savingAction}
                >
                  Save deposit
                </button>
              </div>


                <div className="card stack">
                  <div>
                    <h3>Import store items</h3>
                    <p className="muted">Upload a CSV to add or update barcode-priced items.</p>
                  </div>
                  <div className="inline-form wrap">
                    <button type="button" onClick={downloadItemTemplate}>
                      Download item CSV template
                    </button>
                    <button
                      type="button"
                      onClick={() => itemImportRef.current?.click()}
                      disabled={savingAction}
                    >
                      Import items CSV
                    </button>
                    <input
                      ref={itemImportRef}
                      type="file"
                      accept=".csv,text/csv"
                      hidden
                      onChange={importItemsCsv}
                    />
                  </div>
                  <div className="muted">
                    Required columns: item_name, barcode_value, price.
                  </div>
                </div>

              <div className="card stack">
                <div className="section-head">
                  <div>
                    <h3>Store items</h3>
                    <p className="muted">Add barcode-priced items for canteen or craft shack.</p>
                  </div>
                  <button type="button" onClick={() => setShowAddItem((current) => !current)}>
                    {showAddItem ? "Close" : "Add item"}
                  </button>
                </div>

                {showAddItem ? (
                  <form className="stack" onSubmit={createItem}>
                    <label>
                      Item name
                      <input
                        value={itemForm.item_name}
                        onChange={(event) =>
                          setItemForm((current) => ({ ...current, item_name: event.target.value }))
                        }
                        required
                      />
                    </label>
                    <div className="grid-2">
                      <label>
                        Barcode
                        <input
                          value={itemForm.barcode_value}
                          onChange={(event) =>
                            setItemForm((current) => ({
                              ...current,
                              barcode_value: event.target.value,
                            }))
                          }
                          required
                        />
                      </label>
                      <label>
                        Price
                        <input
                          value={itemForm.price}
                          onChange={(event) =>
                            setItemForm((current) => ({ ...current, price: event.target.value }))
                          }
                          placeholder="2.50"
                          required
                        />
                      </label>
                    </div>
                    <button type="submit" disabled={savingAction}>
                      Save item
                    </button>
                  </form>
                ) : (
                  <div className="items-list">
                    {items.slice(0, 8).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`list-button ${selectedItemId === item.id ? "selected" : ""}`}
                        onClick={() => setSelectedItemId(item.id)}
                      >
                        <span>{item.item_name}</span>
                        <span>{formatMoneyFromCents(item.price_cents)}</span>
                      </button>
                    ))}
                    {!items.length ? <div className="empty">No store items yet.</div> : null}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        <section className="panel stack report-panel">
          <div className="section-head">
            <div>
              <h2>Transaction reports</h2>
              <p className="muted">Filter recent transactions and export them to CSV.</p>
            </div>
            <button type="button" onClick={exportTransactions}>
              Export CSV
            </button>
          </div>

          <div className="grid-4">
            <label>
              Type
              <select
                value={reportFilter.type}
                onChange={(event) =>
                  setReportFilter((current) => ({ ...current, type: event.target.value }))
                }
              >
                <option value="all">All</option>
                <option value="charge">Charges</option>
                <option value="deposit">Deposits</option>
                <option value="void">Voids</option>
              </select>
            </label>

            <label>
              Start date
              <input
                type="date"
                value={reportFilter.startDate}
                onChange={(event) =>
                  setReportFilter((current) => ({ ...current, startDate: event.target.value }))
                }
              />
            </label>

            <label>
              End date
              <input
                type="date"
                value={reportFilter.endDate}
                onChange={(event) =>
                  setReportFilter((current) => ({ ...current, endDate: event.target.value }))
                }
              />
            </label>

            <div className="card summary-card">
              <div className="label">Filtered totals</div>
              <div className="muted">
                Charges: {reportSummary.chargeCount} /{" "}
                {formatMoneyFromCents(reportSummary.chargeTotal)}
              </div>
              <div className="muted">
                Deposits: {reportSummary.depositCount} /{" "}
                {formatMoneyFromCents(reportSummary.depositTotal)}
              </div>
            </div>
          </div>

          <div className="report-table">
            <div className="report-head">
              <div>Time</div>
              <div>Type</div>
              <div>Camper</div>
              <div>Item / Note</div>
              <div>Amount</div>
            </div>
            <div className="report-body">
             {filteredTransactions.map((entry) => {
  const canVoid = entry.transaction_type === "charge" && !entry.voided_at;

  return (
    <div key={entry.id} className="report-row">
      <div>{formatDate(entry.created_at)}</div>

      <div>
        <div className={`pill ${entry.transaction_type}`}>{entry.transaction_type}</div>
        {entry.voided_at ? <div className="muted">Voided</div> : null}
      </div>

      <div>
        <div>{entry.campers?.full_name ?? "Unknown camper"}</div>
        <div className="muted">{entry.campers?.camper_id ?? ""}</div>
      </div>

      <div>
        <div>{entry.store_items?.item_name || entry.note || "—"}</div>
        <div className="muted">
          {entry.note && entry.store_items?.item_name ? entry.note : ""}
        </div>
      </div>

      <div>
        <div>{formatMoneyFromCents(entry.amount_cents)}</div>
        {canVoid ? (
          <button
            type="button"
            onClick={() => voidTransaction(entry.id)}
            disabled={savingAction}
            style={{ marginTop: "0.35rem" }}
          >
            Void
          </button>
        ) : null}
      </div>
    </div>
  );
})}
              {!filteredTransactions.length ? (
                <div className="empty">No transactions match the current filters.</div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
