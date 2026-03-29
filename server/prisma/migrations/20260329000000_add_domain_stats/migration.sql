-- CreateTable
CREATE TABLE "DomainStats" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hostname" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainStats_hostname_date_key" ON "DomainStats"("hostname", "date");

-- CreateIndex
CREATE INDEX "DomainStats_hostname_idx" ON "DomainStats"("hostname");

-- CreateIndex
CREATE INDEX "DomainStats_date_idx" ON "DomainStats"("date");
