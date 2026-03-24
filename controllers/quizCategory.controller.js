import QuizCategoryModel from "../models/QuizCategorySchema.js";
import QuizModel from "../models/QuizSchema.js";

// Create a new quiz category
export const createQuizCategory = async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }

    const existingCategory = await QuizCategoryModel.findOne({ name: name.trim() });
    if (existingCategory) {
      return res.status(400).json({ message: "Category with this name already exists" });
    }

    const category = await QuizCategoryModel.create({
      name: name.trim(),
      description: (description || "").trim(),
      createdBy: req.admin._id,
    });

    return res.status(201).json({
      message: "Quiz Category created successfully",
      category,
    });
  } catch (error) {
    console.error("Error creating quiz category:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

// Get all quiz categories
export const getQuizCategories = async (req, res) => {
  try {
    const { includeInactive } = req.query;
    const query = includeInactive === 'true' ? {} : { isActive: true };

    const categories = await QuizCategoryModel.find(query).sort({ createdAt: -1 }).lean();

    // Get quiz count for each category
    const categoriesWithCount = await Promise.all(
      categories.map(async (category) => {
        const quizCount = await QuizModel.countDocuments({ category: category._id });
        return {
          ...category,
          totalQuizzes: quizCount,
        };
      })
    );

    res.status(200).json(categoriesWithCount);
  } catch (error) {
    console.error("Error fetching quiz categories:", error);
    res.status(500).json({ message: "Failed to fetch categories", error: error.message });
  }
};

// Get a single quiz category by ID
export const getQuizCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await QuizCategoryModel.findById(id);

    if (!category) {
      return res.status(404).json({ message: "Quiz Category not found" });
    }

    const quizCount = await QuizModel.countDocuments({ category: category._id });

    res.status(200).json({
      ...category.toObject(),
      totalQuizzes: quizCount,
    });
  } catch (error) {
    console.error("Error fetching quiz category:", error);
    res.status(500).json({ message: "Failed to fetch category", error: error.message });
  }
};

// Update a quiz category
export const updateQuizCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;

    const category = await QuizCategoryModel.findById(id);
    if (!category) {
      return res.status(404).json({ message: "Quiz Category not found" });
    }

    if (name && name.trim() !== category.name) {
      const existingCategory = await QuizCategoryModel.findOne({
        name: name.trim(),
        _id: { $ne: id }
      });

      if (existingCategory) {
        return res.status(400).json({ message: "Quiz Category with this name already exists" });
      }
    }

    if (name) category.name = name.trim();
    if (description) category.description = description.trim();
    if (typeof isActive === 'boolean') category.isActive = isActive;

    await category.save();

    res.status(200).json({
      message: "Quiz Category updated successfully",
      category,
    });
  } catch (error) {
    console.error("Error updating quiz category:", error);
    res.status(500).json({ message: "Failed to update category", error: error.message });
  }
};

// Delete a quiz category
export const deleteQuizCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await QuizCategoryModel.findById(id);

    if (!category) {
      return res.status(404).json({ message: "Quiz Category not found" });
    }

    const quizCount = await QuizModel.countDocuments({ category: category._id });
    if (quizCount > 0) {
      return res.status(400).json({
        message: `Cannot delete category. It has ${quizCount} quiz(zes). Please delete the quizzes first.`,
      });
    }

    await QuizCategoryModel.findByIdAndDelete(id);

    res.status(200).json({ message: "Quiz Category deleted successfully" });
  } catch (error) {
    console.error("Error deleting quiz category:", error);
    res.status(500).json({ message: "Failed to delete category", error: error.message });
  }
};
