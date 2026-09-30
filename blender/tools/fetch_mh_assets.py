"""Download the MakeHuman CC0 system asset pack (eyes, eyebrows, eyelashes, teeth, tongue, hair, skins, clothes) and
unpack the parts the build uses into build/mh_assets/ (git-ignored). Plain Python 3, no Blender needed.

Run (project root):  python blender/tools/fetch_mh_assets.py [--dest build/mh_assets] [--zip <already downloaded zip>]

The pack (~280 MB) comes from the MakeHuman community asset server. Every asset in it is declared CC0 in
packs/makehuman_system_assets.json and in the header of each .mhclo/.mhmat ("explicitly released as CC0 in
september 2020"). blender/build_base.py re-checks the license of every asset it uses and refuses non-CC0 ones.
"""
import argparse
import os
import sys
import urllib.request
import zipfile

URL = "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"
PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# only these top-level folders are unpacked (proxymeshes are not used)
KEEP = ("packs/", "eyes/", "eyebrows/", "eyelashes/", "teeth/", "tongue/", "hair/", "skins/", "clothes/")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dest", default=os.path.join(PROJECT, "build", "mh_assets"))
    p.add_argument("--zip", help="use an already downloaded makehuman_system_assets_cc0.zip")
    a = p.parse_args()
    os.makedirs(a.dest, exist_ok=True)
    z = a.zip
    if not z:
        z = os.path.join(a.dest, "makehuman_system_assets_cc0.zip")
        if not os.path.isfile(z):
            print("FETCH downloading", URL)
            urllib.request.urlretrieve(URL, z + ".part")
            os.replace(z + ".part", z)
    with zipfile.ZipFile(z) as zf:
        names = [n for n in zf.namelist() if n.startswith(KEEP)]
        zf.extractall(a.dest, members=names)
    print("FETCH unpacked %d files into %s" % (len(names), a.dest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
