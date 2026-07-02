pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";

// Higher than screen resolution so printed output stays crisp.
const RENDER_SCALE = 2;

const fileInput = document.getElementById("file-input");
const fileNameEl = document.getElementById("file-name");
const pageInfoEl = document.getElementById("page-info");
const printBtn = document.getElementById("print-btn");
const emptyMessage = document.getElementById("empty-message");
const pagesContainer = document.getElementById("pages");

fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  loadPdf(file);
});

printBtn.addEventListener("click", () => {
  window.print();
});

async function loadPdf(file) {
  printBtn.disabled = true;
  fileNameEl.textContent = file.name;
  pageInfoEl.textContent = "読み込み中...";
  pagesContainer.innerHTML = "";

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    emptyMessage.style.display = "none";
    await renderAllPages(pdf);
    pageInfoEl.textContent = `${pdf.numPages} ページ`;
    printBtn.disabled = false;
  } catch (error) {
    console.error(error);
    pageInfoEl.textContent = "";
    alert("PDFファイルを読み込めませんでした。ファイルが破損しているか、対応していない形式の可能性があります。");
  }
}

async function renderAllPages(pdf) {
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");

    const pageWrapper = document.createElement("div");
    pageWrapper.className = "page";
    pageWrapper.appendChild(canvas);
    pagesContainer.appendChild(pageWrapper);

    await page.render({ canvasContext: context, viewport }).promise;
  }
}
