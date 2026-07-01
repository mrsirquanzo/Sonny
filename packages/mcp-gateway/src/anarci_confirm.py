"""ANARCI bridge for Sonny. Reads {sequences,scheme} JSON on stdin, writes one JSON object on stdout.

Contract: stdout carries ONLY the final JSON. All warnings/logging go to stderr so a stray
line can never corrupt the JSON the TypeScript side parses.
"""
import sys
import json
import os
import warnings
import logging


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def gene_str(entry):
    # ANARCI germline entry looks like [(species, gene), score]; be defensive about shape.
    try:
        return str(entry[0][1])
    except (IndexError, TypeError):
        return ""


def species_str(entry):
    try:
        return str(entry[0][0])
    except (IndexError, TypeError):
        return ""


def main():
    # Route noise away from stdout.
    warnings.simplefilter("ignore")
    logging.basicConfig(stream=sys.stderr, level=logging.ERROR)

    try:
        from anarci import anarci
    except Exception as exc:  # ANARCI/HMMER not installed
        emit({"status": "anarci_unavailable", "error": str(exc)})
        return

    try:
        req = json.loads(sys.stdin.read())
        scheme = req.get("scheme", "imgt")
        seqs = [(s["id"], s["seq"]) for s in req.get("sequences", [])]

        # OS-level stdout guard - redirect fd 1 to fd 2 so C-level writes
        # from HMMER cannot corrupt the JSON we emit after.
        saved_fd = os.dup(1)
        os.dup2(2, 1)          # send any C-level stdout writes to stderr during compute
        try:
            numbered, details, _hits = anarci(seqs, scheme=scheme, assign_germline=True, output=False)
        finally:
            os.dup2(saved_fd, 1)   # restore real stdout before we emit JSON
            os.close(saved_fd)

        out_domains = []
        for i, (seq_id, _seq) in enumerate(seqs):
            dom = numbered[i]
            det = details[i]
            if not dom:
                continue  # no variable domain aligned (orphan / non-antibody)
            numbering_list = dom[0][0]           # [ ((num:int, ins:str), aa:str), ... ]
            d0 = det[0]
            germ = d0.get("germlines", {}) or {}
            numbering = [["{}{}".format(num, ins).strip(), aa] for ((num, ins), aa) in numbering_list]
            out_domains.append({
                "inputId": seq_id,
                "chain": d0.get("chain_type", "H"),
                "species": species_str(germ.get("v_gene")) or d0.get("species", ""),
                "germline": {"v": gene_str(germ.get("v_gene")), "j": gene_str(germ.get("j_gene"))},
                "numbering": numbering,
            })

        emit({"status": "ok", "domains": out_domains})
    except Exception as exc:
        emit({"status": "anarci_unavailable", "error": str(exc)})


if __name__ == "__main__":
    main()
