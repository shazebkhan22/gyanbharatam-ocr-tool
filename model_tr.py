import cv2
import numpy as np
import os
from PIL import Image
import re


# =========================================================
# NATURAL SORT
# =========================================================
def natural_sort_key(filename):
    return [
        int(t) if t.isdigit() else t.lower()
        for t in re.split(r'(\d+)', filename)
    ]


# =========================================================
# BINARIZATION
# =========================================================
def binarize(img):

    # light blur
    img = cv2.GaussianBlur(img, (3, 3), 0)

    # otsu threshold
    _, th = cv2.threshold(
        img,
        0,
        255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    # ensure:
    # text = black
    # bg = white
    if np.mean(th) < 127:
        th = 255 - th

    return th


# =========================================================
# TEXT MASK
# =========================================================
def get_mask(img):

    mask = (img == 0).astype(np.uint8)

    return mask


# =========================================================
# LINE DETECTION - ORIGINAL
# =========================================================
def get_lines(projection):

    lines = []

    threshold = max(
        1,
        np.max(projection) * 0.015
    )

    in_line = False
    start = 0

    for i, val in enumerate(projection):

        if val > threshold and not in_line:

            start = i
            in_line = True

        elif val <= threshold and in_line:

            # preserve tiny handwritten lines
            if i - start >= 2:

                lines.append((start, i))

            in_line = False

    if in_line:
        lines.append((start, len(projection)-1))

    return lines


# =========================================================
# SPLIT LARGE SEGMENTS (PARAGRAPHS) INTO INDIVIDUAL LINES
# =========================================================
def split_paragraph_into_lines(projection_segment, offset, paragraph_threshold=60):
    """
    Split a large paragraph segment into individual lines
    using internal gap detection.
    
    Parameters:
    - projection_segment: horizontal projection of the paragraph
    - offset: starting row index of the paragraph
    - paragraph_threshold: if segment > this height, split it
    """
    
    # Use higher threshold (25%) to find WHITE GAPS between lines
    internal_threshold = max(1, np.max(projection_segment) * 0.25)
    
    lines = []
    in_line = False
    start = 0
    
    for i, val in enumerate(projection_segment):
        if val > internal_threshold and not in_line:
            start = i
            in_line = True
        elif val <= internal_threshold and in_line:
            if i - start >= 2:
                lines.append((offset + start, offset + i))
            in_line = False
    
    if in_line:
        lines.append((offset + start, offset + len(projection_segment) - 1))
    
    # If splitting failed, return original segment
    return lines if lines else [(offset, offset + len(projection_segment) - 1)]


# =========================================================
# REFINED LINE DETECTION WITH PARAGRAPH SPLITTING
# =========================================================
def get_lines_adaptive(projection, paragraph_threshold=60):
    """
    NEW FUNCTION: Detects lines AND paragraphs.
    
    - First finds all segments (lines + paragraphs)
    - Then: If segment height > paragraph_threshold, split it internally
    - Returns: List of individual line segments
    
    Parameters:
    - projection: horizontal projection from image
    - paragraph_threshold: pixel height above which to split (default: 60px)
                         Adjust based on your handwriting size:
                         - Small: 40-50px
                         - Medium: 50-70px
                         - Large: 70-100px
    """
    
    # First pass: detect all segments (lines + paragraphs mixed)
    initial_lines = get_lines(projection)
    
    refined_lines = []
    
    # Second pass: check each segment and split if too large
    for y1, y2 in initial_lines:
        segment_height = y2 - y1
        
        # If segment is TALL = it's probably a paragraph → SPLIT IT
        if segment_height > paragraph_threshold:
            sub_projection = projection[y1:y2]
            split_lines = split_paragraph_into_lines(sub_projection, y1, paragraph_threshold)
            refined_lines.extend(split_lines)
        else:
            # Single line, keep as-is
            refined_lines.append((y1, y2))
    
    return refined_lines


# =========================================================
# EXTRACT TEXT LINES
# =========================================================
def extract_text_lines_from_image(
        image_path,
        text_path,
        line_counter,
        anno_file,
        output_folder,
        paragraph_threshold=60):

    img = cv2.imread(
        image_path,
        cv2.IMREAD_GRAYSCALE
    )

    if img is None:
        print(f"❌ Failed: {image_path}")
        return line_counter

    # -----------------------------------------------------
    # BINARIZE
    # -----------------------------------------------------
    img = binarize(img)

    # -----------------------------------------------------
    # MASK
    # -----------------------------------------------------
    mask = get_mask(img)

    if np.sum(mask) == 0:
        print(f"⚠ Empty mask: {image_path}")
        return line_counter

    # -----------------------------------------------------
    # HORIZONTAL PROJECTION
    # -----------------------------------------------------
    projection = np.sum(mask, axis=1)

    # ============================================
    # DETECT LINES - NOW WITH PARAGRAPH SPLITTING
    # ============================================
    lines = get_lines_adaptive(projection, paragraph_threshold=paragraph_threshold)

    # fallback
    if len(lines) == 0:
        lines = [(0, img.shape[0])]

    # -----------------------------------------------------
    # LOAD TEXT LINES
    # -----------------------------------------------------
    text_lines = []

    if os.path.exists(text_path):

        with open(
                text_path,
                "r",
                encoding="utf-8") as f:

            text_lines = [
                l.strip()
                for l in f.readlines()
                if l.strip()
            ]

    else:
        print(f"⚠ Missing text file: {text_path}")

    print(
        f"{os.path.basename(image_path)} | "
        f"Detected: {len(lines)} | "
        f"Expected: {len(text_lines)}"
    )

    os.makedirs(output_folder, exist_ok=True)

    # -----------------------------------------------------
    # PROCESS EACH LINE
    # -----------------------------------------------------
    for idx, (y1, y2) in enumerate(lines):

        # padding
        pad = 4

        y1 = max(0, y1 - pad)
        y2 = min(img.shape[0], y2 + pad)

        line_img = img[y1:y2, :]

        # -------------------------------------------------
        # REMOVE EMPTY LEFT/RIGHT SPACE
        # -------------------------------------------------
        col_sum = np.sum(line_img == 0, axis=0)

        cols = np.where(col_sum > 0)[0]

        if len(cols) > 0:

            x1 = max(0, cols[0] - 2)
            x2 = min(
                line_img.shape[1],
                cols[-1] + 3
            )

            line_img = line_img[:, x1:x2]

        # skip invalid
        if line_img.shape[0] == 0 or line_img.shape[1] == 0:
            continue

        # -------------------------------------------------
        # SAVE IMAGE
        # -------------------------------------------------
        filename = f"{line_counter}.jpg"

        save_path = os.path.join(
            output_folder,
            filename
        )

        # IMPORTANT:
        # save ORIGINAL SIZE
        Image.fromarray(line_img).save(
            save_path,
            format="JPEG",
            quality=95
        )

        # -------------------------------------------------
        # WRITE ANNOTATION
        # -------------------------------------------------
        if idx < len(text_lines):
            txt = text_lines[idx]
        else:
            txt = "[NO_TEXT]"

        anno_file.write(
            f"{filename}\t{txt}\n"
        )

        print(f"Saved: {filename}")

        line_counter += 1

    # -----------------------------------------------------
    # REPORT MISMATCH
    # -----------------------------------------------------
    if len(text_lines) > len(lines):

        print(
            f"⚠ Missing image lines: "
            f"{len(text_lines) - len(lines)}"
        )

    return line_counter


# =========================================================
# PROCESS ENTIRE FOLDER
# =========================================================
def process_folder(
        image_folder,
        text_folder,
        output_folder='line_images',
        anno_filename='annotations.txt',
        paragraph_threshold=60):

    os.makedirs(output_folder, exist_ok=True)

    exts = (
        '.png',
        '.jpg',
        '.jpeg',
        '.bmp',
        '.tif',
        '.tiff'
    )

    images = [

        os.path.join(image_folder, f)

        for f in os.listdir(image_folder)

        if f.lower().endswith(exts)

    ]

    images.sort(
        key=lambda x:
        natural_sort_key(
            os.path.basename(x)
        )
    )

    if len(images) == 0:
        print("❌ No images found")
        return

    print(f"Found {len(images)} images")
    print(f"Paragraph threshold: {paragraph_threshold}px")
    print()

    anno_path = os.path.join(
        output_folder,
        anno_filename
    )

    # -----------------------------------------------------
    # PROCESS
    # -----------------------------------------------------
    with open(
            anno_path,
            "w",
            encoding="utf-8") as anno_file:

        line_counter = 1

        for i, image_path in enumerate(images, 1):

            page_name = os.path.splitext(
                os.path.basename(image_path)
            )[0]

            text_path = os.path.join(
                text_folder,
                f"{page_name}.txt"
            )

            print(
                f"\n[{i}/{len(images)}] "
                f"{os.path.basename(image_path)}"
            )

            line_counter = extract_text_lines_from_image(
                image_path,
                text_path,
                line_counter,
                anno_file,
                output_folder,
                paragraph_threshold=paragraph_threshold
            )

    print(f"\n✅ DONE → {anno_path}")


# =========================================================
# RUN
# =========================================================
if __name__ == "__main__":

    # =====================================================
    # ADJUST THESE PARAMETERS FOR YOUR MANUSCRIPT
    # =====================================================
    PARAGRAPH_THRESHOLD = 60  # ← TUNE THIS!
    # If extracting paragraphs as single blocks:
    #   - Lower to 50 or 40 (split more aggressively)
    # If over-splitting single lines:
    #   - Raise to 70 or 80 (split less aggressively)

    process_folder(
        image_folder="Dataset/Images",
        text_folder="Dataset/Text",
        output_folder="Dataset/Outlines2",
        paragraph_threshold=PARAGRAPH_THRESHOLD
    )