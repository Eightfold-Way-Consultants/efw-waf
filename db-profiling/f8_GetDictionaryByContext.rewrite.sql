-- Rewrite of [dbo].[f8_GetDictionaryByContext] — set-based, no temp table / 9 indexes /
-- cursor / explicit transaction. Behavior-equivalent to the cursor version: keeps the
-- single highest-context DictEntry row per (vchrName, vchrSlotRef), same tie-break order.
--
-- Equivalence: ROW_NUMBER()=1 over PARTITION BY (vchrName,vchrSlotRef) with the SAME
-- ORDER BY the old cursor used == "keep the first row per name/slot in that order".
-- The LEFT JOIN to DataClass is 1:1 on iDataClassID, so doing it after the dedup can't
-- change which rows survive. Output column list/order matches the old `SELECT * FROM #tDict`.
--
-- Validate with test-dict-proc-equivalence.ps1 BEFORE deploying. This proc also serves
-- LIVE web rendering, not just export.
USE [CM00]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
ALTER PROCEDURE [dbo].[f8_GetDictionaryByContext]
(
  @ip_iSiteID        [int]
, @ip_iPageClassID   [int] = NULL
, @ip_iPageVariantID [int] = NULL
, @ip_iLanguageID    [int] = NULL
, @ip_iSiteVersionID [int] = NULL
, @ip_iPageID        [int] = NULL
, @ip_iNodeID        [int] = NULL
)
AS
BEGIN
    SET NOCOUNT ON;

    ;WITH ranked AS (
        SELECT  de.iDictEntryID, de.iPageID, de.iPageClassID, de.iPageVariantID, de.iLanguageID,
                de.iSiteVersionID, de.iSiteID, de.iNodeID, de.vchrSlotRef, de.vchrName, de.iValueType,
                de.vchrValue, de.iValue, de.iDataClassID,
                ROW_NUMBER() OVER (
                    PARTITION BY de.vchrName, de.vchrSlotRef
                    ORDER BY de.iPageID DESC, de.iNodeID DESC, de.iPageClassID DESC,
                             de.iPageVariantID DESC, de.iSiteID DESC,
                             CASE WHEN ISNULL(de.iSiteVersionID,-1) = ISNULL(@ip_iSiteVersionID,-1) THEN 1 ELSE 0 END DESC,
                             CASE WHEN ISNULL(de.iLanguageID,-1)    = ISNULL(@ip_iLanguageID,-1)    THEN 1 ELSE 0 END DESC
                ) AS rn
        FROM    DictEntry de
        WHERE   (de.iSiteID        = @ip_iSiteID
              OR de.iPageClassID   = @ip_iPageClassID
              OR de.iPageVariantID = @ip_iPageVariantID
              OR de.iPageID        = @ip_iPageID
              OR de.iNodeID        = @ip_iNodeID)
          AND   (de.iLanguageID    IS NULL OR (ISNULL(de.iLanguageID,-1)    = ISNULL(@ip_iLanguageID,-1)))
          AND   (de.iSiteVersionID IS NULL OR (ISNULL(de.iSiteVersionID,-1) = ISNULL(@ip_iSiteVersionID,-1)))
    )
    SELECT  r.iDictEntryID, r.iPageID, r.iPageClassID, r.iPageVariantID, r.iLanguageID,
            r.iSiteVersionID, r.iSiteID, r.iNodeID, r.vchrSlotRef, r.vchrName, r.iValueType,
            r.vchrValue, r.iValue, r.iDataClassID,
            dc.vchrDataClassName, dc.vchrTableName, dc.vchrColName
    FROM    ranked r
    LEFT JOIN DataClass dc ON r.iDataClassID = dc.iDataClassID
    WHERE   r.rn = 1;
END
GO

-- OPTIONAL supporting index (separate decision — adds write cost on DictEntry, ~57k rows).
-- The OR-filter is still non-SARGable across iPageClassID/iPageVariantID/iPageID/iNodeID
-- (none indexed today). The set-based rewrite alone removes the cursor/temp/9-index cost;
-- this index would additionally let the filter seek instead of scan. Evaluate after the
-- rewrite is in:
--   CREATE NONCLUSTERED INDEX IX_DictEntry_ctx ON dbo.DictEntry
--     (iSiteID, iNodeID, iPageID, iPageClassID, iPageVariantID)
--     INCLUDE (iLanguageID, iSiteVersionID, vchrSlotRef, vchrName, iValueType, vchrValue, iValue, iDataClassID);
